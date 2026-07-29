import { extension_settings, getContext } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    saveChatConditional,
    updateMessageBlock,
    generateQuietPrompt,
    generateRaw,
} from '../../../../script.js';

const MODULE_NAME = 'ru_fixer';
const LOG = '[RU-Fixer]';

const SYSTEM_PROMPT = 'Ты — точный редактор-переводчик. Ты не участвуешь в ролевой игре, не отыгрываешь персонажей и ничего не сочиняешь. Ты возвращаешь только обработанный текст, без комментариев и пояснений.';

const DEFAULT_PROMPT = `[Служебная задача. Это не ролевая игра.
Ниже дан фрагмент текста. Основной язык текста — русский, но в нём случайно встречаются английские слова и фразы.
Задача: перевести ТОЛЬКО английские слова и фразы на русский так, чтобы они естественно вписались в смысл, падеж, число, род и стиль предложения.
Правила:
1. Русские части текста не изменяй ни на букву.
2. Полностью сохрани структуру, абзацы, пунктуацию и форматирование (*курсив*, **жирный**, "кавычки", разметку).
3. Ничего не добавляй, не сокращай, не продолжай текст, не комментируй.
4. Не трогай имена собственные и ники, содержимое блоков кода и макросы в двойных фигурных скобках.
5. Если английских слов нет — верни текст без изменений.
Ответь ТОЛЬКО итоговым текстом, без пояснений и без кавычек вокруг него.]

ТЕКСТ:
{{text}}`;

const defaultSettings = {
    enabled: true,
    auto: false,
    minLen: 2,
    skipCode: true,
    whitelist: '',
    prompt: DEFAULT_PROMPT,
    notify: true,
    sanity: true,
    contextCount: 1,
    responseLength: 0,      // 0 = авто
    useChatContext: false,  // true = generateQuietPrompt с историей чата

    // --- собственный OpenAI-совместимый бэкенд ---
    useCustomApi: false,
    apiUrl: 'https://api.rout.my/v1',
    apiKey: '',
    apiModel: '',
    apiTemp: 0.2,
    apiTimeout: 120,
    apiHeaders: '',            // доп. заголовки в JSON
    useCompletionTokens: false, // max_completion_tokens вместо max_tokens
    useCorsProxy: false,       // гнать через встроенный CORS-прокси ST
};

let busy = false;

function settings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][k] === undefined) {
            extension_settings[MODULE_NAME][k] = v;
        }
    }
    return extension_settings[MODULE_NAME];
}

/* ---------------- детект английских слов ---------------- */

function stripProtected(text) {
    return String(text)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`\n]*`/g, ' ')
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/\{\{[^}]*\}\}/g, ' ')
        .replace(/<[^>]+>/g, ' ');
}

function findEnglishWords(text) {
    const s = settings().skipCode ? stripProtected(text) : String(text);
    const white = new Set(
        String(settings().whitelist).toLowerCase().split(/[\s,;]+/).filter(Boolean),
    );
    const found = new Set();
    const re = /[A-Za-z][A-Za-z'’\-]*/g;
    let m;
    while ((m = re.exec(s)) !== null) {
        const w = m[0];
        if (w.length < settings().minLen) continue;
        if (white.has(w.toLowerCase())) continue;
        found.add(w);
    }
    return [...found];
}

/* ---------------- собственный API ---------------- */

function baseUrl() {
    let u = String(settings().apiUrl || '').trim();
    while (u.endsWith('/')) u = u.slice(0, -1);
    return u;
}

function chatUrl() {
    const u = baseUrl();
    if (!u) return '';
    if (u.endsWith('#')) return u.slice(0, -1);              // точный URL как есть
    if (u.endsWith('/chat/completions')) return u;
    return `${u}/chat/completions`;
}

function modelsUrl() {
    let u = baseUrl();
    if (u.endsWith('#')) u = u.slice(0, -1);
    u = u.replace(/\/chat\/completions$/, '');
    return `${u}/models`;
}

function withProxy(url) {
    return settings().useCorsProxy ? `/proxy/${url}` : url;
}

function buildHeaders() {
    const s = settings();
    const headers = { 'Content-Type': 'application/json' };
    if (s.apiKey) headers['Authorization'] = `Bearer ${s.apiKey.trim()}`;
    if (String(s.apiHeaders).trim()) {
        try {
            Object.assign(headers, JSON.parse(s.apiHeaders));
        } catch {
            console.warn(`${LOG} доп. заголовки — некорректный JSON, пропущены`);
        }
    }
    return headers;
}

async function callCustomAPI(prompt, maxTokens) {
    const s = settings();
    const url = chatUrl();
    if (!url) throw new Error('Не задан URL собственного API.');
    if (!s.apiModel) throw new Error('Не задано имя модели.');

    const body = {
        model: s.apiModel,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
        ],
        temperature: Number(s.apiTemp),
        stream: false,
    };
    if (s.useCompletionTokens) body.max_completion_tokens = maxTokens;
    else body.max_tokens = maxTokens;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(10, Number(s.apiTimeout)) * 1000);

    let res;
    try {
        res = await fetch(withProxy(url), {
            method: 'POST',
            headers: buildHeaders(),
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') throw new Error('Таймаут запроса к собственному API.');
        throw new Error(`Сеть/CORS: ${err.message}. Попробуй включить "через CORS-прокси ST".`);
    }
    clearTimeout(timer);

    const raw = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);

    let data;
    try { data = JSON.parse(raw); }
    catch { throw new Error(`Некорректный JSON в ответе: ${raw.slice(0, 200)}`); }

    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

    const choice = data?.choices?.[0];
    const content =
        choice?.message?.content ??
        choice?.message?.reasoning_content ??
        choice?.text ??
        data?.content ??
        '';

    if (Array.isArray(content)) {
        return content.map(p => (typeof p === 'string' ? p : p?.text ?? '')).join('');
    }
    return String(content ?? '');
}

async function fetchModelList() {
    const url = modelsUrl();
    const res = await fetch(withProxy(url), { method: 'GET', headers: buildHeaders() });
    const raw = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);
    const data = JSON.parse(raw);
    const list = data?.data ?? data?.models ?? [];
    return list.map(m => (typeof m === 'string' ? m : m.id ?? m.name)).filter(Boolean).sort();
}

/* ---------------- вызов модели ---------------- */

function estimateTokens(text) {
    const auto = Math.ceil(text.length / 1.6) + 64;
    return Math.min(Math.max(auto, 200), 4096);
}

async function callLLM(prompt, responseLength) {
    const s = settings();
    const ctx = getContext();

    if (s.useCustomApi) {
        return await callCustomAPI(prompt, responseLength);
    }

    if (s.useChatContext) {
        const fn = ctx.generateQuietPrompt ?? generateQuietPrompt;
        if (fn.length <= 1) {
            return await fn({
                quietPrompt: prompt,
                quietToLoud: false,
                skipWIAN: true,
                responseLength: responseLength,
            });
        }
        return await fn(prompt, false, true, null, null, responseLength);
    }

    const fn = ctx.generateRaw ?? generateRaw;
    if (fn.length <= 1) {
        return await fn({
            prompt: prompt,
            systemPrompt: SYSTEM_PROMPT,
            instructOverride: false,
            quietToLoud: false,
            responseLength: responseLength,
            trimNames: true,
        });
    }
    return await fn(prompt, '', false, false, SYSTEM_PROMPT, responseLength);
}

function buildPrompt(text, messageId) {
    const s = settings();
    let contextBlock = '';

    if (s.contextCount > 0) {
        const chat = getContext().chat;
        const prev = chat
            .slice(Math.max(0, messageId - s.contextCount), messageId)
            .map(m => `${m.name}: ${m.mes}`)
            .join('\n');
        if (prev.trim()) {
            contextBlock = `КОНТЕКСТ (только для понимания смысла; переводить и выводить его НЕ надо):\n${prev}\n\n`;
        }
    }

    const body = s.prompt.includes('{{text}}')
        ? s.prompt.replace('{{text}}', text)
        : `${s.prompt}\n\n${text}`;

    return contextBlock + body;
}

function cleanResult(raw, original) {
    if (!raw) return null;
    let t = String(raw).trim();

    t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    const fence = t.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
    if (fence) t = fence[1].trim();

    t = t.replace(/^"""\s*/, '').replace(/\s*"""$/, '').trim();
    t = t.replace(/^(вот|ниже|итог\w*|результат|исправленн\w*|перевед\w*)[^\n:]{0,60}:\s*\n+/i, '').trim();
    t = t.replace(/^ТЕКСТ:\s*/i, '').trim();

    const wrapped = t.length > 1 && t.startsWith('"') && t.endsWith('"');
    const origWrapped = original.startsWith('"') && original.endsWith('"');
    if (wrapped && !origWrapped) t = t.slice(1, -1).trim();

    if (!t) return null;

    if (settings().sanity) {
        const ratio = t.length / original.length;
        if (ratio < 0.55 || ratio > 1.9) {
            console.warn(`${LOG} результат отклонён (ratio=${ratio.toFixed(2)})`, t);
            return null;
        }
    }
    return t;
}

/* ---------------- основная функция ---------------- */

async function fixMessage(messageId, { silent = false } = {}) {
    const s = settings();
    const ctx = getContext();
    const message = ctx.chat?.[messageId];

    if (!message) return false;
    if (message.is_user || message.is_system) {
        if (!silent) toastr.info('Это сообщение не проверяется (пользователь/система).');
        return false;
    }

    const original = String(message.mes ?? '');
    if (!original.trim()) return false;

    if (busy) {
        if (!silent) toastr.warning('Проверка уже выполняется, подожди.');
        return false;
    }

    const words = findEnglishWords(original);
    if (words.length === 0) {
        if (!silent && s.notify) toastr.info('Английских слов не найдено.');
        return false;
    }

    busy = true;
    const $btn = $(`#chat .mes[mesid="${messageId}"] .mes_ru_fix`);
    $btn.addClass('ru_fixer_spin');

    try {
        console.log(`${LOG} найдено:`, words);

        const prompt = buildPrompt(original, messageId);
        const len = s.responseLength > 0 ? s.responseLength : estimateTokens(original);
        const raw = await callLLM(prompt, len);
        const fixed = cleanResult(raw, original);

        if (!fixed) {
            if (!silent) toastr.error('Модель вернула некорректный результат. Изменений нет.');
            return false;
        }
        if (fixed === original) {
            if (!silent && s.notify) toastr.info('Изменений не потребовалось.');
            return false;
        }

        message.extra = message.extra || {};
        if (!message.extra.ru_fixer_original) message.extra.ru_fixer_original = original;
        message.mes = fixed;

        if (Array.isArray(message.swipes) && typeof message.swipe_id === 'number') {
            message.swipes[message.swipe_id] = fixed;
        }

        updateMessageBlock(messageId, message);
        await saveChatConditional();

        if (s.notify) toastr.success(`Исправлено слов/фраз: ${words.length}`, 'RU Fixer');
        return true;
    } catch (err) {
        console.error(`${LOG} ошибка:`, err);
        if (!silent) toastr.error(String(err.message || err), 'RU Fixer');
        return false;
    } finally {
        busy = false;
        $btn.removeClass('ru_fixer_spin');
    }
}

async function revertMessage(messageId) {
    const ctx = getContext();
    const message = ctx.chat?.[messageId];
    const orig = message?.extra?.ru_fixer_original;

    if (!orig) {
        toastr.info('Оригинал не сохранён для этого сообщения.');
        return;
    }

    message.mes = orig;
    if (Array.isArray(message.swipes) && typeof message.swipe_id === 'number') {
        message.swipes[message.swipe_id] = orig;
    }
    delete message.extra.ru_fixer_original;

    updateMessageBlock(messageId, message);
    await saveChatConditional();
    toastr.success('Возвращён оригинальный текст.');
}

async function fixLastMessage() {
    const chat = getContext().chat;
    if (!chat?.length) return;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user && !chat[i].is_system) {
            await fixMessage(i);
            return;
        }
    }
}

/* ---------------- кнопки в сообщениях ---------------- */

const BUTTON_HTML = `<div class="mes_button mes_ru_fix fa-solid fa-language interactable" tabindex="0"
    title="RU Fixer: перевести английские слова (Shift+клик — вернуть оригинал)"></div>`;

function injectButtons() {
    const $tpl = $('#message_template .mes_buttons .extraMesButtons');
    if ($tpl.length && !$tpl.find('.mes_ru_fix').length) $tpl.prepend(BUTTON_HTML);

    $('#chat .mes .mes_buttons .extraMesButtons').each(function () {
        if (!$(this).find('.mes_ru_fix').length) $(this).prepend(BUTTON_HTML);
    });
}

/* ---------------- настройки UI ---------------- */

const SETTINGS_HTML = `
<div class="ru_fixer_settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>RU Fixer — доперевод английских слов</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">

      <label class="checkbox_label"><input id="ruf_enabled" type="checkbox"> Включить расширение</label>
      <label class="checkbox_label"><input id="ruf_auto" type="checkbox"> Автоматически проверять ответ персонажа</label>
      <label class="checkbox_label"><input id="ruf_skipcode" type="checkbox"> Игнорировать код, ссылки, макросы и HTML</label>
      <label class="checkbox_label"><input id="ruf_sanity" type="checkbox"> Защита от «фантазий» модели (проверка длины ответа)</label>
      <label class="checkbox_label"><input id="ruf_notify" type="checkbox"> Показывать уведомления</label>

      <hr class="sysHR">
      <label class="checkbox_label"><input id="ruf_usecustom" type="checkbox">
        <b>Использовать свой OpenAI-совместимый API</b> (вместо текущего подключения ST)</label>

      <div id="ruf_custom_block">
        <label for="ruf_url">URL (базовый, обычно оканчивается на /v1)</label>
        <input id="ruf_url" class="text_pole" type="text" placeholder="https://api.rout.my/v1">

        <label for="ruf_key">API Key</label>
        <input id="ruf_key" class="text_pole" type="password" placeholder="sk-...">

        <label for="ruf_model">Модель</label>
        <div class="flex-container flexGap5">
          <input id="ruf_model" class="text_pole flex1" type="text" list="ruf_model_list" placeholder="gpt-4o-mini">
          <datalist id="ruf_model_list"></datalist>
          <input id="ruf_models_btn" class="menu_button" type="button" value="Список моделей">
        </div>

        <label for="ruf_temp">Температура</label>
        <input id="ruf_temp" class="text_pole" type="number" step="0.05" min="0" max="2">

        <label for="ruf_timeout">Таймаут запроса, сек</label>
        <input id="ruf_timeout" class="text_pole" type="number" min="10" max="600">

        <label for="ruf_headers">Доп. заголовки (JSON, необязательно)</label>
        <textarea id="ruf_headers" class="text_pole textarea_compact" rows="2"
          placeholder='{"HTTP-Referer":"https://localhost","X-Title":"SillyTavern"}'></textarea>

        <label class="checkbox_label"><input id="ruf_comptokens" type="checkbox">
          Слать max_completion_tokens вместо max_tokens (новые модели OpenAI)</label>
        <label class="checkbox_label"><input id="ruf_corsproxy" type="checkbox">
          Гнать через CORS-прокси SillyTavern (если браузер блокирует запрос)</label>

        <div class="flex-container">
          <input id="ruf_test" class="menu_button" type="button" value="Проверить подключение">
        </div>
        <div id="ruf_status" class="opacity50p"></div>
      </div>

      <hr class="sysHR">
      <label class="checkbox_label"><input id="ruf_usechat" type="checkbox">
        Если свой API выключен: слать проверку вместе с историей чата</label>

      <label for="ruf_minlen">Минимальная длина английского слова для реакции</label>
      <input id="ruf_minlen" class="text_pole" type="number" min="1" max="10">

      <label for="ruf_ctx">Сколько предыдущих сообщений подклеить как контекст (0 — не подклеивать)</label>
      <input id="ruf_ctx" class="text_pole" type="number" min="0" max="6">

      <label for="ruf_len">Лимит ответа в токенах (0 — авто)</label>
      <input id="ruf_len" class="text_pole" type="number" min="0" max="8192">

      <label for="ruf_white">Белый список (через запятую): имена, ники, аббревиатуры</label>
      <textarea id="ruf_white" class="text_pole textarea_compact" rows="2"
        placeholder="Alex, Kaine, OK, HP, USB"></textarea>

      <label for="ruf_prompt">Промпт (в тексте должно быть <code>{{text}}</code>)</label>
      <textarea id="ruf_prompt" class="text_pole textarea_compact" rows="10"></textarea>

      <div class="flex-container">
        <input id="ruf_reset" class="menu_button" type="button" value="Сбросить промпт">
        <input id="ruf_run" class="menu_button" type="button" value="Проверить последнее сообщение">
      </div>

      <small class="opacity50p">Ключ хранится в настройках SillyTavern в открытом виде — не используй на чужом сервере.
      Исправленный текст заменяет оригинал, поэтому в контекст следующей генерации уходит уже русская версия.
      Оригинал доступен по Shift+клику на кнопке в сообщении.</small>

    </div>
  </div>
</div>`;

function toggleCustomBlock() {
    $('#ruf_custom_block').toggle(!!settings().useCustomApi);
}

function loadSettingsUI() {
    const s = settings();
    $('#ruf_enabled').prop('checked', s.enabled);
    $('#ruf_auto').prop('checked', s.auto);
    $('#ruf_skipcode').prop('checked', s.skipCode);
    $('#ruf_sanity').prop('checked', s.sanity);
    $('#ruf_notify').prop('checked', s.notify);
    $('#ruf_usechat').prop('checked', s.useChatContext);

    $('#ruf_usecustom').prop('checked', s.useCustomApi);
    $('#ruf_url').val(s.apiUrl);
    $('#ruf_key').val(s.apiKey);
    $('#ruf_model').val(s.apiModel);
    $('#ruf_temp').val(s.apiTemp);
    $('#ruf_timeout').val(s.apiTimeout);
    $('#ruf_headers').val(s.apiHeaders);
    $('#ruf_comptokens').prop('checked', s.useCompletionTokens);
    $('#ruf_corsproxy').prop('checked', s.useCorsProxy);

    $('#ruf_minlen').val(s.minLen);
    $('#ruf_ctx').val(s.contextCount);
    $('#ruf_len').val(s.responseLength);
    $('#ruf_white').val(s.whitelist);
    $('#ruf_prompt').val(s.prompt);

    toggleCustomBlock();
}

function bindSettingsUI() {
    const s = settings();
    const save = () => saveSettingsDebounced();

    $('#ruf_enabled').on('change', function () { s.enabled = !!$(this).prop('checked'); save(); });
    $('#ruf_auto').on('change', function () { s.auto = !!$(this).prop('checked'); save(); });
    $('#ruf_skipcode').on('change', function () { s.skipCode = !!$(this).prop('checked'); save(); });
    $('#ruf_sanity').on('change', function () { s.sanity = !!$(this).prop('checked'); save(); });
    $('#ruf_notify').on('change', function () { s.notify = !!$(this).prop('checked'); save(); });
    $('#ruf_usechat').on('change', function () { s.useChatContext = !!$(this).prop('checked'); save(); });

    $('#ruf_usecustom').on('change', function () {
        s.useCustomApi = !!$(this).prop('checked');
        toggleCustomBlock();
        save();
    });
    $('#ruf_url').on('input', function () { s.apiUrl = String($(this).val()).trim(); save(); });
    $('#ruf_key').on('input', function () { s.apiKey = String($(this).val()).trim(); save(); });
    $('#ruf_model').on('input', function () { s.apiModel = String($(this).val()).trim(); save(); });
    $('#ruf_temp').on('input', function () { s.apiTemp = Number($(this).val()); save(); });
    $('#ruf_timeout').on('input', function () { s.apiTimeout = Number($(this).val()) || 120; save(); });
    $('#ruf_headers').on('input', function () { s.apiHeaders = String($(this).val()); save(); });
    $('#ruf_comptokens').on('change', function () { s.useCompletionTokens = !!$(this).prop('checked'); save(); });
    $('#ruf_corsproxy').on('change', function () { s.useCorsProxy = !!$(this).prop('checked'); save(); });

    $('#ruf_minlen').on('input', function () { s.minLen = Number($(this).val()) || 2; save(); });
    $('#ruf_ctx').on('input', function () { s.contextCount = Number($(this).val()) || 0; save(); });
    $('#ruf_len').on('input', function () { s.responseLength = Number($(this).val()) || 0; save(); });
    $('#ruf_white').on('input', function () { s.whitelist = String($(this).val()); save(); });
    $('#ruf_prompt').on('input', function () { s.prompt = String($(this).val()); save(); });

    $('#ruf_reset').on('click', function () {
        s.prompt = DEFAULT_PROMPT;
        $('#ruf_prompt').val(DEFAULT_PROMPT);
        save();
    });

    $('#ruf_run').on('click', () => fixLastMessage());

    $('#ruf_models_btn').on('click', async function () {
        $('#ruf_status').text('Загружаю список моделей...');
        try {
            const models = await fetchModelList();
            const $list = $('#ruf_model_list').empty();
            models.forEach(m => $list.append(`<option value="${$('<div>').text(m).html()}">`));
            $('#ruf_status').text(`Найдено моделей: ${models.length}. Нажми на поле «Модель» — появится список.`);
        } catch (err) {
            console.error(`${LOG} models:`, err);
            $('#ruf_status').text(`Ошибка: ${err.message}`);
        }
    });

    $('#ruf_test').on('click', async function () {
        $('#ruf_status').text('Пробую отправить тестовый запрос...');
        try {
            const answer = await callCustomAPI('Ответь одним словом: работает', 20);
            $('#ruf_status').text(`OK. Ответ модели: ${String(answer).slice(0, 120)}`);
            toastr.success('Подключение работает', 'RU Fixer');
        } catch (err) {
            console.error(`${LOG} test:`, err);
            $('#ruf_status').text(`Ошибка: ${err.message}`);
            toastr.error(String(err.message), 'RU Fixer');
        }
    });
}

/* ---------------- инициализация ---------------- */

jQuery(async () => {
    settings();

    $('#extensions_settings2').append(SETTINGS_HTML);
    loadSettingsUI();
    bindSettingsUI();

    injectButtons();

    $('#extensionsMenu').append(`
        <div id="ruf_menu_item" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
            <div class="fa-solid fa-language extensionsMenuExtensionButton"></div>
            <span>RU Fixer: исправить последнее сообщение</span>
        </div>`);
    $(document).on('click', '#ruf_menu_item', () => fixLastMessage());

    $(document).on('click', '.mes_ru_fix', async function (e) {
        const id = Number($(this).closest('.mes').attr('mesid'));
        if (Number.isNaN(id)) return;
        if (e.shiftKey) await revertMessage(id);
        else await fixMessage(id);
    });

    const onRendered = async (messageId) => {
        const s = settings();
        injectButtons();
        if (!s.enabled || !s.auto) return;
        const id = Number(messageId);
        const chat = getContext().chat;
        if (id !== chat.length - 1) return;
        await fixMessage(id, { silent: true });
    };

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onRendered);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, () => injectButtons());
    eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(injectButtons, 200));
    eventSource.on(event_types.MORE_MESSAGES_LOADED, () => injectButtons());

    try {
        const { SlashCommandParser } = await import('../../../slash-commands/SlashCommandParser.js');
        const { SlashCommand } = await import('../../../slash-commands/SlashCommand.js');
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'fixru',
            callback: async (_args, value) => {
                const chat = getContext().chat;
                const id = value ? Number(value) : chat.length - 1;
                await fixMessage(id);
                return '';
            },
            helpString: 'Перевести английские слова в сообщении (по умолчанию — в последнем).',
        }));
    } catch (err) {
        console.warn(`${LOG} слэш-команда не зарегистрирована:`, err);
    }

    console.log(`${LOG} загружен`);
});
