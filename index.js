// AI Synonym Swapper — SillyTavern extension
// Визуально заменяет нежелательные слова-клише в сообщениях на синонимы,
// подобранные ИИ-моделью. Оригинальный текст в чате НЕ изменяется
// (используется display_text, как в расширении-переводчике).
//
// Возможности:
//  - Замены сохраняются между сессиями и переприменяются при загрузке чата.
//  - При редактировании сообщения замена автоматически пересчитывается.
//  - Можно подключить СВОЙ Extra API (Custom AI, OpenAI-совместимый),
//    чтобы не использовать основную модель.

(function () {
    'use strict';

    const MODULE = 'synonym_swapper';

    const defaultSettings = Object.freeze({
        enabled: true,
        words: [],
        processUserMessages: false,
        autoProcess: true,
        // Custom / Extra API
        useCustomApi: false,
        customApiUrl: '',
        customApiKey: '',
        customApiModel: '',
    });

    // Сообщения, которые обрабатываются прямо сейчас (защита от повторных запросов)
    const inFlight = new Set();

    function getContext() {
        return SillyTavern.getContext();
    }

    function getSettings() {
        const { extensionSettings } = getContext();
        if (!extensionSettings[MODULE]) {
            extensionSettings[MODULE] = structuredClone(defaultSettings);
        }
        for (const key of Object.keys(defaultSettings)) {
            if (!Object.hasOwn(extensionSettings[MODULE], key)) {
                extensionSettings[MODULE][key] = structuredClone(defaultSettings[key]);
            }
        }
        return extensionSettings[MODULE];
    }

    function saveSettings() {
        getContext().saveSettingsDebounced();
    }

    // ------------------------------------------------------------------
    // Поиск нежелательных слов (учитываются грамматические формы:
    // слово матчится как основа + любые буквенные окончания)
    // ------------------------------------------------------------------

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function buildWordRegex(word) {
        const escaped = escapeRegex(word.trim());
        try {
            return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}[\\p{L}]*`, 'giu');
        } catch {
            return new RegExp(escaped, 'gi');
        }
    }

    function findBannedWords(text, words) {
        const found = [];
        for (const word of words) {
            if (!word) continue;
            if (buildWordRegex(word).test(text)) {
                found.push(word);
            }
        }
        return found;
    }

    function hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = (hash << 5) - hash + str.charCodeAt(i);
            hash |= 0;
        }
        return String(hash);
    }

    // ------------------------------------------------------------------
    // Промпт
    // ------------------------------------------------------------------

    function buildSystemPrompt() {
        return [
            'Ты — точный литературный редактор. Ты выполняешь ровно одну задачу: заменяешь указанные слова на СЛОВА-СИНОНИМЫ, не меняя ничего больше.',
            'Перед заменой ты ВНИМАТЕЛЬНО прочитываешь весь текст целиком, чтобы понять смысл, тон, ситуацию и эмоциональную окраску, и только затем подбираешь синоним, который лучше всего подходит именно в этом контексте.',
        ].join(' ');
    }

    function buildUserPrompt(text, words) {
        return [
            'Ниже дан ПОЛНЫЙ текст сообщения. Сначала прочитай его целиком и пойми контекст: кто говорит, о чём речь, какое настроение и стиль.',
            'Затем замени в нём ВСЕ вхождения следующих слов, включая любые их грамматические формы (падежи, числа, времена) и однокоренные слова с тем же значением, на естественные синонимы:',
            '',
            words.map((w) => `- ${w}`).join('\n'),
            '',
            'Строгие правила:',
            '1. Для КАЖДОГО вхождения подбирай синоним ОТДЕЛЬНО, исходя из окружающих слов и смысла предложения — одно и то же слово в разных местах может требовать разных синонимов.',
            '2. Заменяй слово на ОДНО слово-синоним (в крайнем случае максимально короткий эквивалент). НЕ превращай слово в описательную фразу.',
            '   Пример правильно: «собственничество» → «ревность» / «эгоизм» / «властность».',
            '   Пример НЕПРАВИЛЬНО: «собственничество» → «чувство собственности».',
            '3. Синоним обязан подходить по контексту и сохранять исходный смысл предложения, не искажая ситуацию.',
            '4. Каждый раз подбирай РАЗНЫЕ синонимы, не повторяйся между вызовами.',
            '5. Сохраняй грамматическую форму (падеж, число, род, время) исходного слова, чтобы предложение оставалось согласованным.',
            '6. НЕ изменяй никакие другие слова, пунктуацию, форматирование, разметку (*курсив*, "кавычки" и т.п.).',
            '7. Верни ТОЛЬКО итоговый текст целиком, без пояснений, без префиксов, без кавычек-обёрток.',
            '',
            'Текст:',
            text,
        ].join('\n');
    }

    // ------------------------------------------------------------------
    // Запрос к своему Extra API (OpenAI-совместимый /chat/completions)
    // ------------------------------------------------------------------

    function resolveCompletionsUrl(rawUrl) {
        let url = String(rawUrl || '').trim().replace(/\/+$/, '');
        if (!url) return '';
        if (/\/chat\/completions$/i.test(url)) return url;
        if (/\/v1$/i.test(url)) return `${url}/chat/completions`;
        return `${url}/v1/chat/completions`;
    }

    async function callCustomApi(text, words) {
        const s = getSettings();
        const url = resolveCompletionsUrl(s.customApiUrl);
        if (!url) throw new Error('Не задан URL кастомного API.');
        if (!s.customApiModel) throw new Error('Не задано имя модели кастомного API.');

        const headers = { 'Content-Type': 'application/json' };
        if (s.customApiKey) headers['Authorization'] = `Bearer ${s.customApiKey}`;

        const body = {
            model: s.customApiModel,
            messages: [
                { role: 'system', content: buildSystemPrompt() },
                { role: 'user', content: buildUserPrompt(text, words) },
            ],
            temperature: 0.9,
            stream: false,
        };

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`Custom API ${response.status}: ${errText.slice(0, 200)}`);
        }

        const data = await response.json();
        return (
            data?.choices?.[0]?.message?.content ??
            data?.choices?.[0]?.text ??
            null
        );
    }

    // ------------------------------------------------------------------
    // Запрос к основному ИИ SillyTavern
    // ------------------------------------------------------------------

    async function callMainApi(text, words) {
        const context = getContext();
        const systemPrompt = buildSystemPrompt();
        const prompt = buildUserPrompt(text, words);

        let result = null;

        // Новый API: generateRaw({ prompt, systemPrompt })
        try {
            if (typeof context.generateRaw === 'function') {
                result = await context.generateRaw({ prompt, systemPrompt });
            }
        } catch (error) {
            console.warn('[SynonymSwapper] generateRaw (object args) failed, trying fallback', error);
        }

        // Старый API: generateRaw(prompt, api, instructOverride, quietToLoud, systemPrompt)
        if (typeof result !== 'string' || !result.trim()) {
            try {
                if (typeof context.generateRaw === 'function') {
                    result = await context.generateRaw(prompt, null, false, false, systemPrompt);
                }
            } catch (error) {
                console.warn('[SynonymSwapper] generateRaw (positional args) failed', error);
            }
        }

        // Запасной вариант: generateQuietPrompt
        if (typeof result !== 'string' || !result.trim()) {
            try {
                if (typeof context.generateQuietPrompt === 'function') {
                    result = await context.generateQuietPrompt({ quietPrompt: prompt });
                }
            } catch (error) {
                console.error('[SynonymSwapper] generateQuietPrompt failed', error);
            }
        }

        return result;
    }

    async function requestRewrite(text, words) {
        const settings = getSettings();

        let result = settings.useCustomApi
            ? await callCustomApi(text, words)
            : await callMainApi(text, words);

        if (typeof result !== 'string') return null;

        // Убираем возможные обёртки из ответа модели
        let cleaned = result.trim();
        cleaned = cleaned.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
        return cleaned || null;
    }

    // ------------------------------------------------------------------
    // Отрисовка
    // ------------------------------------------------------------------

    function updateMessageBlock(messageId, message) {
        const context = getContext();
        if (typeof context.updateMessageBlock === 'function') {
            context.updateMessageBlock(messageId, message);
            return;
        }
        // Ручное обновление DOM (запасной вариант)
        const textToRender = message?.extra?.display_text ?? message.mes;
        const mesBlock = $(`#chat .mes[mesid="${messageId}"]`);
        const mesText = mesBlock.find('.mes_text');
        if (!mesText.length) return;
        if (typeof context.messageFormatting === 'function') {
            mesText.html(
                context.messageFormatting(textToRender, message.name, message.is_system, message.is_user, messageId),
            );
        } else {
            mesText.text(textToRender);
        }
    }

    function setLoadingState(messageId, isLoading) {
        const mesBlock = $(`#chat .mes[mesid="${messageId}"]`);
        mesBlock.toggleClass('ss--loading', isLoading);
    }

    // Переприменить ранее сохранённую подмену без нового запроса к ИИ.
    // Нужна при загрузке чата / подгрузке старых сообщений, т.к. ST
    // при первичном рендере показывает исходный mes.
    function reapplyMessage(messageId) {
        const context = getContext();
        const message = context.chat[messageId];
        if (!message?.extra?.display_text || !message.extra.ss_key) return;

        // Проверяем, что сохранённая замена всё ещё соответствует тексту.
        const words = getSettings().words.filter(Boolean);
        const key = hashString(message.mes + '|' + words.join(','));
        if (message.extra.ss_key !== key) return; // текст изменился — не применяем устаревшую замену

        updateMessageBlock(messageId, message);
    }

    function reapplyAllMessages() {
        const context = getContext();
        for (let i = 0; i < context.chat.length; i++) {
            reapplyMessage(i);
        }
    }

    // ------------------------------------------------------------------
    // Основная обработка
    // ------------------------------------------------------------------

    async function processMessage(messageId, force = false) {
        const context = getContext();
        const settings = getSettings();

        if (!settings.enabled) return;
        if (!force && !settings.autoProcess) return;
        if (inFlight.has(messageId)) return;

        const message = context.chat[messageId];
        if (!message || message.is_system) return;
        if (message.is_user && !settings.processUserMessages) return;

        const words = settings.words.filter(Boolean);
        if (!words.length) return;

        const original = message.mes;
        if (!original) return;

        const found = findBannedWords(original, words);
        if (!found.length) {
            // В тексте больше нет запрещённых слов — сбрасываем устаревшую замену
            if (message.extra?.ss_key) {
                delete message.extra.display_text;
                delete message.extra.ss_key;
                updateMessageBlock(messageId, message);
            }
            return;
        }

        // Ключ = текст + список слов. Если совпадает — переприменяем сохранённое.
        const key = hashString(original + '|' + words.join(','));
        if (!force && message.extra?.ss_key === key && message.extra?.display_text) {
            updateMessageBlock(messageId, message);
            return;
        }

        inFlight.add(messageId);
        setLoadingState(messageId, true);

        try {
            const rewritten = await requestRewrite(original, found);
            if (!rewritten || rewritten === original) return;

            message.extra = message.extra || {};
            message.extra.display_text = rewritten;
            message.extra.ss_key = key;

            updateMessageBlock(messageId, message);

            if (typeof context.saveChat === 'function') {
                await context.saveChat();
            }
        } catch (error) {
            console.error('[SynonymSwapper] Failed to process message', messageId, error);
            toastr.error(String(error?.message || error), 'Synonym Swapper');
        } finally {
            inFlight.delete(messageId);
            setLoadingState(messageId, false);
        }
    }

    // Обработка редактирования сообщения: старая замена больше не актуальна.
    // ВАЖНО: SillyTavern ДОЖИДАЕТСЯ обработчиков MESSAGE_EDITED перед своим
    // повторным рендером. Поэтому здесь нельзя await'ить запрос к ИИ —
    // иначе сохранение правки «зависает» до ответа API. Делаем всё быстро и
    // синхронно, а пересчёт синонимов запускаем отдельно, после рендера ST.
    function handleMessageEdited(messageId) {
        const context = getContext();
        const message = context.chat[messageId];
        if (!message) return;

        const settings = getSettings();
        const hadReplacement = Boolean(message.extra?.ss_key);

        // Немедленно убираем устаревшую подмену и показываем чистый
        // отредактированный текст, чтобы старый синоним не «завис» поверх нового.
        if (hadReplacement) {
            delete message.extra.display_text;
            delete message.extra.ss_key;
            updateMessageBlock(messageId, message);
        }

        if (!settings.enabled) return;

        // Пересчитываем синонимы для нового текста, если:
        //  - включён авто-режим, ИЛИ
        //  - у этого сообщения ранее уже была замена (значит пользователь
        //    хочет сохранить синонимизацию и после правки — «возвращаем» её).
        // Запускаем без блокировки, после того как ST закончит свой рендер.
        if (settings.autoProcess || hadReplacement) {
            setTimeout(() => {
                processMessage(messageId, true);
            }, 50);
        }
    }

    function restoreMessage(messageId) {
        const context = getContext();
        const message = context.chat[messageId];
        if (!message?.extra?.ss_key) return;
        delete message.extra.display_text;
        delete message.extra.ss_key;
        updateMessageBlock(messageId, message);
    }

    async function processLastMessage() {
        const context = getContext();
        const lastId = context.chat.length - 1;
        if (lastId < 0) {
            toastr.warning('В чате нет сообщений.', 'Synonym Swapper');
            return;
        }
        await processMessage(lastId, true);
        toastr.success('Последнее сообщение обработано.', 'Synonym Swapper');
    }

    async function processAllMessages() {
        const context = getContext();
        const settings = getSettings();
        if (!settings.words.length) {
            toastr.warning('Сначала добавьте нежелательные слова.', 'Synonym Swapper');
            return;
        }
        toastr.info('Обрабатываю все сообщения чата…', 'Synonym Swapper');
        for (let i = 0; i < context.chat.length; i++) {
            await processMessage(i, true);
        }
        toastr.success('Готово!', 'Synonym Swapper');
    }

    function restoreAllMessages() {
        const context = getContext();
        for (let i = 0; i < context.chat.length; i++) {
            restoreMessage(i);
        }
        if (typeof context.saveChat === 'function') {
            context.saveChat();
        }
        toastr.info('Оригинальный текст восстановлен.', 'Synonym Swapper');
    }

    // ------------------------------------------------------------------
    // UI настроек
    // ------------------------------------------------------------------

    function renderWordList() {
        const settings = getSettings();
        const list = $('#ss_word_list');
        list.empty();

        if (!settings.words.length) {
            list.append('<small class="ss-empty">Список пуст. Добавьте слово выше.</small>');
            return;
        }

        for (const word of settings.words) {
            const chip = $('<span class="ss-chip"></span>');
            chip.append($('<span></span>').text(word));
            const removeBtn = $('<button class="ss-chip-remove" title="Удалить">&times;</button>');
            removeBtn.on('click', () => {
                const s = getSettings();
                s.words = s.words.filter((w) => w !== word);
                saveSettings();
                renderWordList();
            });
            chip.append(removeBtn);
            list.append(chip);
        }
    }

    function addWordFromInput() {
        const input = $('#ss_word_input');
        const raw = String(input.val() || '');
        // Поддержка ввода нескольких слов через запятую
        const newWords = raw
            .split(',')
            .map((w) => w.trim().toLowerCase())
            .filter(Boolean);

        if (!newWords.length) return;

        const settings = getSettings();
        for (const word of newWords) {
            if (!settings.words.includes(word)) {
                settings.words.push(word);
            }
        }
        saveSettings();
        input.val('');
        renderWordList();
    }

    function buildSettingsHtml() {
        return `
<div class="synonym-swapper-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>AI Synonym Swapper</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label">
                <input id="ss_enabled" type="checkbox" />
                <span>Включено</span>
            </label>
            <label class="checkbox_label">
                <input id="ss_auto" type="checkbox" />
                <span>Автоматически синонимизировать после каждого ответа бота</span>
            </label>
            <small class="ss-hint">
                Если выключить — новые ответы не обрабатываются автоматически,
                но вы можете запустить обработку вручную кнопками ниже.
            </small>
            <label class="checkbox_label">
                <input id="ss_user_messages" type="checkbox" />
                <span>Обрабатывать и сообщения пользователя</span>
            </label>
            <hr />
            <label for="ss_word_input"><small>Нежелательные слова (можно несколько через запятую):</small></label>
            <div class="ss-input-row">
                <input id="ss_word_input" class="text_pole" type="text" placeholder="собственничество, хмыкнул…" />
                <div id="ss_add_word" class="menu_button menu_button_icon" title="Добавить слово">
                    <i class="fa-solid fa-plus"></i>
                </div>
            </div>
            <div id="ss_word_list" class="ss-word-list"></div>
            <hr />
            <label class="checkbox_label">
                <input id="ss_use_custom" type="checkbox" />
                <span><b>Использовать свой Extra API (Custom AI)</b></span>
            </label>
            <small class="ss-hint">
                OpenAI-совместимый эндпоинт. Если выключено — используется основная модель SillyTavern.
            </small>
            <div id="ss_custom_fields">
                <label for="ss_custom_url"><small>URL API:</small></label>
                <input id="ss_custom_url" class="text_pole" type="text"
                    placeholder="https://api.openai.com/v1  или  http://localhost:5000/v1" />
                <label for="ss_custom_key"><small>API ключ:</small></label>
                <input id="ss_custom_key" class="text_pole" type="password" placeholder="sk-…" />
                <label for="ss_custom_model"><small>Модель:</small></label>
                <input id="ss_custom_model" class="text_pole" type="text"
                    placeholder="gpt-4o-mini / gemini-1.5-flash / …" />
            </div>
            <hr />
            <div class="ss-buttons">
                <div id="ss_process_last" class="menu_button" title="Обработать последнее сообщение">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> Последнее
                </div>
                <div id="ss_process_all" class="menu_button" title="Обработать все сообщения чата">
                    <i class="fa-solid fa-broom"></i> Весь чат
                </div>
                <div id="ss_restore_all" class="menu_button" title="Показать оригинальный текст">
                    <i class="fa-solid fa-rotate-left"></i> Оригинал
                </div>
            </div>
            <small class="ss-hint">
                Оригинальный текст в чате не изменяется — подмена только визуальная,
                как у встроенного переводчика. Замены сохраняются и восстанавливаются
                при повторном открытии чата.
            </small>
        </div>
    </div>
</div>`;
    }

    function toggleCustomFields() {
        const on = getSettings().useCustomApi;
        $('#ss_custom_fields').toggle(!!on);
    }

    function initSettingsUi() {
        const settings = getSettings();

        $('#extensions_settings2').append(buildSettingsHtml());

        $('#ss_enabled')
            .prop('checked', settings.enabled)
            .on('input', function () {
                getSettings().enabled = $(this).prop('checked');
                saveSettings();
            });

        $('#ss_auto')
            .prop('checked', settings.autoProcess)
            .on('input', function () {
                getSettings().autoProcess = $(this).prop('checked');
                saveSettings();
            });

        $('#ss_user_messages')
            .prop('checked', settings.processUserMessages)
            .on('input', function () {
                getSettings().processUserMessages = $(this).prop('checked');
                saveSettings();
            });

        $('#ss_add_word').on('click', addWordFromInput);
        $('#ss_word_input').on('keydown', function (e) {
            if (e.key === 'Enter' && !e.originalEvent?.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                addWordFromInput();
            }
        });

        // Custom API
        $('#ss_use_custom')
            .prop('checked', settings.useCustomApi)
            .on('input', function () {
                getSettings().useCustomApi = $(this).prop('checked');
                saveSettings();
                toggleCustomFields();
            });

        $('#ss_custom_url')
            .val(settings.customApiUrl)
            .on('input', function () {
                getSettings().customApiUrl = String($(this).val() || '').trim();
                saveSettings();
            });

        $('#ss_custom_key')
            .val(settings.customApiKey)
            .on('input', function () {
                getSettings().customApiKey = String($(this).val() || '').trim();
                saveSettings();
            });

        $('#ss_custom_model')
            .val(settings.customApiModel)
            .on('input', function () {
                getSettings().customApiModel = String($(this).val() || '').trim();
                saveSettings();
            });

        $('#ss_process_last').on('click', processLastMessage);
        $('#ss_process_all').on('click', processAllMessages);
        $('#ss_restore_all').on('click', restoreAllMessages);

        renderWordList();
        toggleCustomFields();
    }

    // ------------------------------------------------------------------
    // Инициализация
    // ------------------------------------------------------------------

    jQuery(async () => {
        const context = getContext();
        const { eventSource, event_types } = context;

        initSettingsUi();

        // Новое сообщение персонажа полностью отрисовано
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
            processMessage(Number(messageId));
        });

        // Свайп на другой вариант ответа
        if (event_types.MESSAGE_SWIPED) {
            eventSource.on(event_types.MESSAGE_SWIPED, (messageId) => {
                processMessage(Number(messageId));
            });
        }

        // Сообщение пользователя отрисовано
        if (event_types.USER_MESSAGE_RENDERED) {
            eventSource.on(event_types.USER_MESSAGE_RENDERED, (messageId) => {
                processMessage(Number(messageId));
            });
        }

        // Редактирование сообщения — пересчитать замену для нового текста
        if (event_types.MESSAGE_EDITED) {
            eventSource.on(event_types.MESSAGE_EDITED, (messageId) => {
                handleMessageEdited(Number(messageId));
            });
        }
        // После сохранения отредактированного сообщения ST заново рендерит блок —
        // переприменяем актуальную замену.
        if (event_types.MESSAGE_UPDATED) {
            eventSource.on(event_types.MESSAGE_UPDATED, (messageId) => {
                reapplyMessage(Number(messageId));
            });
        }

        // Переключение / загрузка чата — восстановить сохранённые замены
        if (event_types.CHAT_CHANGED) {
            eventSource.on(event_types.CHAT_CHANGED, () => {
                setTimeout(reapplyAllMessages, 100);
            });
        }

        // Подгрузка более старых сообщений при прокрутке вверх
        if (event_types.MORE_MESSAGES_LOADED) {
            eventSource.on(event_types.MORE_MESSAGES_LOADED, () => {
                setTimeout(reapplyAllMessages, 100);
            });
        }

        // Первичная отрисовка уже открытого чата
        setTimeout(reapplyAllMessages, 300);

        console.log('[SynonymSwapper] Extension loaded');
    });
})();
