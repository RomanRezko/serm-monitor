const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');

// Load environment variables from .env file (for local development)
try {
    require('dotenv').config();
} catch (e) {
    // dotenv not installed, using system env vars
}

// Claude API client (initialized lazily)
let anthropicClient = null;

function getAnthropicClient() {
    if (!anthropicClient) {
        const config = loadConfig();
        const apiKey = process.env.CLAUDE_API_KEY || config.claudeApiKey;
        if (apiKey) {
            anthropicClient = new Anthropic({ apiKey });
        }
    }
    return anthropicClient;
}

// Reset client when API key changes
function resetAnthropicClient() {
    anthropicClient = null;
}

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../frontend')));

// Async error wrapper - предотвращает необработанные ошибки в async routes
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// Request logging middleware - verbose for debugging
app.use((req, res, next) => {
    const start = Date.now();
    console.log(`[REQ] ${req.method} ${req.path}`);
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[RES] ${req.method} ${req.path} - ${duration}ms`);
    });
    next();
});

// XMLStock API Configuration
// Set your credentials here or via environment variables
const XMLSTOCK_CONFIG = {
    user: process.env.XMLSTOCK_USER || '',  // Your XMLStock user ID
    key: process.env.XMLSTOCK_KEY || '',     // Your XMLStock API key
    googleUrl: 'https://xmlstock.com/google/xml/',
    yandexUrl: 'https://xmlstock.com/yandex/xml/'
};

// Data storage path
const DATA_DIR = path.join(__dirname, '../data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// In-memory storage for active background parsings
const activeParsings = new Map();
// Structure: { taskId: { projectId, entityId, status, progress, currentStep, totalSteps, result, error, startedAt } }

// Load/Save config
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('Error loading config:', error);
    }
    return { xmlstock: { user: '', key: '' } };
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function getXmlStockCredentials() {
    const config = loadConfig();
    return {
        user: XMLSTOCK_CONFIG.user || config.xmlstock?.user || '',
        key: XMLSTOCK_CONFIG.key || config.xmlstock?.key || ''
    };
}

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Load projects from file
function loadProjects() {
    try {
        if (fs.existsSync(PROJECTS_FILE)) {
            return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('Error loading projects:', error);
    }
    return [];
}

// Save projects to file
function saveProjects(projects) {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

// CTR coefficients by position (Top 10 = 100%)
const CTR_COEFFICIENTS = {
    1: 30.0, 2: 20.0, 3: 14.0, 4: 10.0, 5: 7.0,
    6: 6.0, 7: 5.0, 8: 4.0, 9: 2.5, 10: 1.5,
    11: 2.1, 12: 1.9, 13: 1.6, 14: 1.4, 15: 1.3,
    16: 1.2, 17: 1.0, 18: 0.9, 19: 0.8, 20: 0.7,
    21: 0.6, 22: 0.55, 23: 0.5, 24: 0.45, 25: 0.4,
    26: 0.38, 27: 0.36, 28: 0.34, 29: 0.32, 30: 0.3,
    31: 0.28, 32: 0.26, 33: 0.24, 34: 0.22, 35: 0.2,
    36: 0.19, 37: 0.18, 38: 0.17, 39: 0.16, 40: 0.15,
    41: 0.14, 42: 0.13, 43: 0.12, 44: 0.11, 45: 0.1,
    46: 0.09, 47: 0.08, 48: 0.07, 49: 0.06, 50: 0.05,
    // 51-100 have very low CTR
    ...Object.fromEntries(Array.from({length: 50}, (_, i) => [i + 51, 0.03]))
};

// Sentiment comments based on domain type and content
const SENTIMENT_COMMENTS = {
    positive: {
        biography: 'Официальная биография с положительной информацией',
        news: 'Позитивная новостная публикация',
        social: 'Положительные отзывы в социальных сетях',
        review: 'Хвалебные отзывы и рекомендации',
        official: 'Официальный сайт с позитивным контентом',
        media: 'Положительный медиа-контент',
        forum: 'Позитивные обсуждения на форумах'
    },
    negative: {
        biography: 'Биография с негативными фактами или критикой',
        news: 'Негативная или скандальная публикация',
        social: 'Негативные комментарии в соцсетях',
        review: 'Отрицательные отзывы и жалобы',
        official: 'Критическая информация на официальном ресурсе',
        media: 'Компрометирующий медиа-контент',
        forum: 'Негативные обсуждения и критика на форумах'
    },
    neutral: {
        biography: 'Нейтральная биографическая справка',
        news: 'Информационная публикация без оценки',
        social: 'Упоминание без эмоциональной окраски',
        review: 'Нейтральный обзор без явной оценки',
        official: 'Справочная информация',
        media: 'Нейтральный медиа-контент',
        forum: 'Нейтральное обсуждение без оценок'
    }
};

// Domain categories for better sentiment reasoning
const DOMAIN_CATEGORIES = {
    '24smi.org': { type: 'tabloid', bias: 'mixed' },
    'wikipedia.org': { type: 'encyclopedia', bias: 'neutral' },
    'instagram.com': { type: 'social', bias: 'mixed' },
    'vk.com': { type: 'social', bias: 'mixed' },
    'youtube.com': { type: 'video', bias: 'mixed' },
    'tiktok.com': { type: 'social', bias: 'mixed' },
    'eksmo.ru': { type: 'publisher', bias: 'neutral' },
    'litres.ru': { type: 'bookstore', bias: 'neutral' },
    'labirint.ru': { type: 'bookstore', bias: 'neutral' },
    'ozon.ru': { type: 'marketplace', bias: 'neutral' },
    'wildberries.ru': { type: 'marketplace', bias: 'neutral' },
    'avito.ru': { type: 'classifieds', bias: 'neutral' },
    'hh.ru': { type: 'jobs', bias: 'neutral' },
    'dzen.ru': { type: 'blog', bias: 'mixed' },
    'pikabu.ru': { type: 'forum', bias: 'mixed' },
    'habr.com': { type: 'tech', bias: 'neutral' },
    'vc.ru': { type: 'business', bias: 'neutral' },
    'forbes.ru': { type: 'business', bias: 'neutral' },
    'rbc.ru': { type: 'news', bias: 'neutral' },
    'lenta.ru': { type: 'news', bias: 'mixed' },
    'ria.ru': { type: 'news', bias: 'official' },
    'tass.ru': { type: 'news', bias: 'official' },
    'kommersant.ru': { type: 'business', bias: 'neutral' },
    'vedomosti.ru': { type: 'business', bias: 'neutral' },
    'kp.ru': { type: 'tabloid', bias: 'mixed' },
    '5-tv.ru': { type: 'tv', bias: 'official' },
    'ntv.ru': { type: 'tv', bias: 'official' },
    '1tv.ru': { type: 'tv', bias: 'official' },
    'otzovik.com': { type: 'reviews', bias: 'mixed' },
    'irecommend.ru': { type: 'reviews', bias: 'mixed' },
    'flamp.ru': { type: 'reviews', bias: 'mixed' }
};

// Generate sentiment comment based on domain, type, and sentiment
function generateSentimentComment(domain, type, sentiment) {
    const baseComment = SENTIMENT_COMMENTS[sentiment][type] || SENTIMENT_COMMENTS[sentiment].news;
    const domainInfo = DOMAIN_CATEGORIES[domain];

    if (domainInfo) {
        if (domainInfo.type === 'tabloid' && sentiment === 'negative') {
            return 'Таблоидная публикация с негативным уклоном';
        }
        if (domainInfo.type === 'reviews') {
            return sentiment === 'positive' ? 'Положительный отзыв на сайте отзывов' :
                   sentiment === 'negative' ? 'Отрицательный отзыв на сайте отзывов' :
                   'Нейтральный отзыв на сайте отзывов';
        }
        if (domainInfo.type === 'social') {
            return sentiment === 'positive' ? 'Позитивный контент в соцсети' :
                   sentiment === 'negative' ? 'Негативный контент в соцсети' :
                   'Нейтральное упоминание в соцсети';
        }
        if (domainInfo.bias === 'official') {
            return sentiment === 'positive' ? 'Положительная публикация в официальном СМИ' :
                   sentiment === 'negative' ? 'Критическая публикация в официальном СМИ' :
                   'Нейтральная публикация в официальном СМИ';
        }
    }

    return baseComment;
}

// Available regions for search
const REGIONS = {
    'ru': { name: 'Россия', code: 'ru', googleGl: 'ru', yandexLr: '225' },
    'ru-msk': { name: 'Москва', code: 'ru-msk', googleGl: 'ru', yandexLr: '213' },
    'ru-spb': { name: 'Санкт-Петербург', code: 'ru-spb', googleGl: 'ru', yandexLr: '2' },
    'ru-krd': { name: 'Краснодар', code: 'ru-krd', googleGl: 'ru', yandexLr: '35' },
    'ru-nsk': { name: 'Новосибирск', code: 'ru-nsk', googleGl: 'ru', yandexLr: '65' },
    'ru-ekb': { name: 'Екатеринбург', code: 'ru-ekb', googleGl: 'ru', yandexLr: '54' },
    'ua': { name: 'Украина', code: 'ua', googleGl: 'ua', yandexLr: '187' },
    'by': { name: 'Беларусь', code: 'by', googleGl: 'by', yandexLr: '149' },
    'kz': { name: 'Казахстан', code: 'kz', googleGl: 'kz', yandexLr: '159' },
    'us': { name: 'США', code: 'us', googleGl: 'us', yandexLr: '84' },
    'de': { name: 'Германия', code: 'de', googleGl: 'de', yandexLr: '96' },
    'world': { name: 'Весь мир', code: 'world', googleGl: '', yandexLr: '0' }
};

// Get available regions endpoint
function getRegions() {
    return Object.values(REGIONS).map(r => ({ code: r.code, name: r.name }));
}

// Transliterate cyrillic to latin for URL
function transliterate(text) {
    const map = {
        'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
        'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
        'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
        'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch', 'ъ': '',
        'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
        'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E', 'Ё': 'Yo',
        'Ж': 'Zh', 'З': 'Z', 'И': 'I', 'Й': 'Y', 'К': 'K', 'Л': 'L', 'М': 'M',
        'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T', 'У': 'U',
        'Ф': 'F', 'Х': 'H', 'Ц': 'Ts', 'Ч': 'Ch', 'Ш': 'Sh', 'Щ': 'Sch', 'Ъ': '',
        'Ы': 'Y', 'Ь': '', 'Э': 'E', 'Ю': 'Yu', 'Я': 'Ya', ' ': '-'
    };
    return text.split('').map(char => map[char] || char).join('').toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-');
}

// User-Agent strings for requests
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Extract domain from URL
function extractDomain(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname.replace('www.', '');
    } catch {
        return 'unknown';
    }
}

// Determine content type from URL and title
function determineContentType(url, title) {
    const urlLower = url.toLowerCase();
    const titleLower = (title || '').toLowerCase();

    if (urlLower.includes('wiki') || titleLower.includes('википедия')) return 'biography';
    if (urlLower.includes('news') || urlLower.includes('novosti') || titleLower.includes('новост')) return 'news';
    if (urlLower.includes('instagram') || urlLower.includes('vk.com') || urlLower.includes('facebook') || urlLower.includes('tiktok')) return 'social';
    if (urlLower.includes('otzovik') || urlLower.includes('irecommend') || urlLower.includes('flamp') || titleLower.includes('отзыв')) return 'review';
    if (urlLower.includes('youtube') || urlLower.includes('rutube') || urlLower.includes('video')) return 'media';
    if (urlLower.includes('forum') || urlLower.includes('pikabu') || urlLower.includes('dzen')) return 'forum';
    return 'official';
}

// Advanced sentiment analysis with weights, negations, and domain bias
const SENTIMENT_WORDS = {
    positive: {
        // Сильно позитивные (вес 3)
        'выдающийся': 3, 'великолепный': 3, 'блестящий': 3, 'гениальный': 3,
        'легендарный': 3, 'феноменальный': 3, 'триумф': 3, 'прорыв': 3,

        // Умеренно позитивные (вес 2)
        'успех': 2, 'успешн': 2, 'победа': 2, 'победител': 2, 'талант': 2,
        'достижение': 2, 'награда': 2, 'награжден': 2, 'признание': 2,
        'звезда': 2, 'профессионал': 2, 'эксперт': 2, 'мастер': 2,
        'лидер': 2, 'рекорд': 2, 'лауреат': 2, 'чемпион': 2,

        // Слабо позитивные (вес 1)
        'хороший': 1, 'хорош': 1, 'отличн': 1, 'прекрасн': 1, 'замечательн': 1,
        'популярн': 1, 'известн': 1, 'любим': 1, 'уважаем': 1, 'почетн': 1,
        'красив': 1, 'интересн': 1, 'полезн': 1, 'качествен': 1,
        'рекомендуем': 1, 'рекомендую': 1, 'советую': 1, 'нравится': 1,
        'радость': 1, 'счастье': 1, 'счастлив': 1, 'позитив': 1,
        'вдохновля': 1, 'восхища': 1, 'впечатля': 1
    },
    negative: {
        // Сильно негативные (вес 3)
        'мошенник': 3, 'мошенничество': 3, 'афера': 3, 'аферист': 3,
        'преступник': 3, 'преступлен': 3, 'арест': 3, 'арестован': 3,
        'тюрьма': 3, 'заключен': 3, 'убийство': 3, 'убийца': 3,
        'насилие': 3, 'насильник': 3, 'педофил': 3, 'изнасилов': 3,
        'наркотик': 3, 'наркоман': 3, 'коррупц': 3, 'взятк': 3,
        'разоблач': 3, 'компромат': 3,

        // Умеренно негативные (вес 2)
        'скандал': 2, 'провал': 2, 'банкрот': 2, 'банкротств': 2,
        'обман': 2, 'обманул': 2, 'ложь': 2, 'лжец': 2, 'врет': 2,
        'воровств': 2, 'украл': 2, 'кража': 2, 'хищение': 2,
        'обвинен': 2, 'обвиня': 2, 'подозрева': 2, 'подозрение': 2,
        'суд': 2, 'судим': 2, 'штраф': 2, 'иск': 2,
        'увольн': 2, 'уволен': 2, 'отставк': 2,
        'трагедия': 2, 'трагическ': 2, 'гибель': 2, 'смерть': 2,
        'жертв': 2, 'катастроф': 2, 'авария': 2,

        // Слабо негативные (вес 1)
        'критик': 1, 'критику': 1, 'негатив': 1, 'проблем': 1,
        'конфликт': 1, 'спор': 1, 'ссора': 1, 'скандальн': 1,
        'жалоб': 1, 'претензи': 1, 'недовольн': 1, 'возмущен': 1,
        'плох': 1, 'ужасн': 1, 'кошмар': 1, 'отвратительн': 1,
        'разочаров': 1, 'неудач': 1, 'провальн': 1, 'ошибк': 1,
        'кризис': 1, 'долг': 1, 'задолжен': 1,
        'развод': 1, 'измен': 1, 'неверн': 1,
        'алкогол': 1, 'пьян': 1, 'запой': 1,
        'болезн': 1, 'болен': 1, 'диагноз': 1
    }
};

// Слова-отрицания
const NEGATION_WORDS = ['не', 'нет', 'без', 'ни', 'никак', 'никогда', 'нигде', 'никто', 'ничто', 'отсутств'];

// Домены с предвзятостью
const DOMAIN_BIAS = {
    // Негативно-ориентированные ресурсы
    'kompromatwiki.org': -2,
    'compromat.ru': -2,
    'rucriminal.info': -2,
    'kompromat.ru': -2,
    'anticompromat.org': -1,
    'scandal.ru': -1,

    // Нейтрально-информационные
    'wikipedia.org': 0,
    'ru.wikipedia.org': 0,

    // Позитивно-ориентированные (официальные, профессиональные)
    'forbes.ru': 0.5,
    'rbc.ru': 0,
    'vedomosti.ru': 0,
    'kommersant.ru': 0,

    // Социальные сети (нейтральные, зависит от контента)
    'vk.com': 0,
    'instagram.com': 0,
    'facebook.com': 0,
    'youtube.com': 0,
    'tiktok.com': 0,
    'dzen.ru': 0,

    // Отзовики (могут быть как позитивные, так и негативные)
    'otzovik.com': 0,
    'irecommend.ru': 0,
    'flamp.ru': 0
};

function analyzeSentiment(title, snippet, domain = '') {
    // Безопасный анализ без циклов while и сложных regex
    const text = ` ${title || ''} ${snippet || ''} `.toLowerCase().substring(0, 1000);

    // Разбиваем текст на слова один раз (ограничиваем 200 словами для безопасности)
    const textWords = text.split(/[^а-яёa-z0-9]+/i).filter(w => w.length > 0).slice(0, 200);

    let positiveScore = 0;
    let negativeScore = 0;

    // Проверяем каждое слово текста
    for (let i = 0; i < textWords.length; i++) {
        const word = textWords[i];

        // Проверка на отрицание в предыдущих 3 словах
        const hasNegation = textWords.slice(Math.max(0, i - 3), i)
            .some(w => NEGATION_WORDS.includes(w));

        // Ищем совпадения с позитивными словами (по началу слова)
        for (const [keyword, weight] of Object.entries(SENTIMENT_WORDS.positive)) {
            if (word.startsWith(keyword) || word === keyword) {
                if (hasNegation) {
                    negativeScore += weight * 0.5;
                } else {
                    positiveScore += weight;
                }
                break; // Одно слово — одно совпадение
            }
        }

        // Ищем совпадения с негативными словами
        for (const [keyword, weight] of Object.entries(SENTIMENT_WORDS.negative)) {
            if (word.startsWith(keyword) || word === keyword) {
                if (hasNegation) {
                    positiveScore += weight * 0.5;
                } else {
                    negativeScore += weight;
                }
                break;
            }
        }
    }

    // Учёт bias домена
    const domainBias = DOMAIN_BIAS[domain] || 0;
    if (domainBias > 0) {
        positiveScore += domainBias;
    } else if (domainBias < 0) {
        negativeScore += Math.abs(domainBias);
    }

    // Определение итоговой тональности
    const totalScore = positiveScore + negativeScore;
    if (totalScore === 0) return 'neutral';

    const normalizedDiff = (positiveScore - negativeScore) / totalScore;

    if (normalizedDiff > 0.3) return 'positive';
    if (normalizedDiff < -0.3) return 'negative';
    return 'neutral';
}

// Анализ тональности через Claude API (более точный)
async function analyzeSentimentWithClaude(title, snippet, url = '') {
    const client = getAnthropicClient();
    if (!client) {
        // Fallback на локальный анализ если нет API ключа
        console.log('[Sentiment] Claude API not configured, using local analysis');
        return {
            sentiment: analyzeSentiment(title, snippet),
            explanation: 'Локальный анализ (Claude API не настроен)',
            confidence: 0.5
        };
    }

    const text = `Заголовок: ${title || 'Не указан'}\nОписание: ${snippet || 'Не указано'}\nURL: ${url || 'Не указан'}`;

    try {
        const response = await client.messages.create({
            model: 'claude-3-haiku-20240307',
            max_tokens: 200,
            messages: [{
                role: 'user',
                content: `Проанализируй тональность этой публикации относительно репутации персоны или бренда, упомянутого в тексте.

${text}

Ответь СТРОГО в формате JSON:
{
  "sentiment": "positive" | "negative" | "neutral",
  "confidence": 0.0-1.0,
  "explanation": "краткое объяснение на русском (до 100 символов)"
}

Критерии:
- positive: хвалебный отзыв, достижения, успехи, благодарности
- negative: критика, скандалы, проблемы, жалобы, обман, мошенничество
- neutral: информационная статья без оценки, биография, факты

Только JSON, без markdown.`
            }]
        });

        const content = response.content[0].text.trim();
        // Парсим JSON ответ
        const result = JSON.parse(content);

        console.log(`[Sentiment] Claude: ${result.sentiment} (${result.confidence}) - ${title?.substring(0, 50)}`);

        return {
            sentiment: result.sentiment || 'neutral',
            explanation: result.explanation || '',
            confidence: result.confidence || 0.7
        };
    } catch (error) {
        console.error('[Sentiment] Claude API error:', error.message);
        // Fallback на локальный анализ при ошибке
        return {
            sentiment: analyzeSentiment(title, snippet),
            explanation: `Ошибка Claude API: ${error.message}`,
            confidence: 0.3
        };
    }
}

// Батчевый анализ тональности (для оптимизации API вызовов)
async function analyzeSentimentBatch(items) {
    const client = getAnthropicClient();
    const config = loadConfig();

    // Если Claude не настроен или выключен - используем локальный анализ
    if (!client || !config.useClaude) {
        return items.map(item => ({
            ...item,
            sentiment: analyzeSentiment(item.title, item.snippet),
            sentimentExplanation: 'Локальный анализ',
            sentimentConfidence: 0.5
        }));
    }

    // Анализируем каждый элемент через Claude (с задержкой для rate limit)
    const results = [];
    for (const item of items) {
        const analysis = await analyzeSentimentWithClaude(item.title, item.snippet, item.url);
        results.push({
            ...item,
            sentiment: analysis.sentiment,
            sentimentExplanation: analysis.explanation,
            sentimentConfidence: analysis.confidence
        });
        // Небольшая задержка между запросами
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    return results;
}

// Генерация комментария к тональности (безопасная версия)
function generateSentimentExplanation(title, snippet, domain, sentiment) {
    const text = ` ${title || ''} ${snippet || ''} `.toLowerCase();
    const textWords = text.split(/[^а-яёa-z0-9]+/i).filter(w => w.length > 0).slice(0, 200);

    const foundPositive = [];
    const foundNegative = [];

    // Проверяем каждое слово текста
    for (const word of textWords) {
        // Ищем позитивные
        for (const [keyword, weight] of Object.entries(SENTIMENT_WORDS.positive)) {
            if (word.startsWith(keyword)) {
                foundPositive.push({ word, weight });
                break;
            }
        }
        // Ищем негативные
        for (const [keyword, weight] of Object.entries(SENTIMENT_WORDS.negative)) {
            if (word.startsWith(keyword)) {
                foundNegative.push({ word, weight });
                break;
            }
        }
    }

    // Сортировка по весу
    foundPositive.sort((a, b) => b.weight - a.weight);
    foundNegative.sort((a, b) => b.weight - a.weight);

    // Формирование комментария
    let comment = '';

    if (sentiment === 'positive') {
        if (foundPositive.length > 0) {
            const keywords = foundPositive.slice(0, 3).map(w => `"${w.word}"`).join(', ');
            comment = `Позитивные маркеры: ${keywords}`;
        } else {
            comment = 'Общий позитивный тон публикации';
        }
    } else if (sentiment === 'negative') {
        if (foundNegative.length > 0) {
            const keywords = foundNegative.slice(0, 3).map(w => `"${w.word}"`).join(', ');
            comment = `Негативные маркеры: ${keywords}`;
        } else {
            comment = 'Общий негативный тон публикации';
        }

        // Добавляем информацию о домене если он негативный
        const domainBias = DOMAIN_BIAS[domain];
        if (domainBias && domainBias < 0) {
            comment += ` | Источник: компроматный ресурс`;
        }
    } else {
        if (foundPositive.length === 0 && foundNegative.length === 0) {
            comment = 'Нейтральная информационная публикация';
        } else {
            comment = 'Смешанная тональность, баланс позитива и негатива';
        }
    }

    return comment;
}

// XMLStock Google API parser
async function parseGoogleXmlStock(query, depth, region) {
    const results = [];
    const credentials = getXmlStockCredentials();

    if (!credentials.user || !credentials.key) {
        console.error('XMLStock credentials not configured');
        return results;
    }

    const regionInfo = REGIONS[region] || REGIONS['ru'];
    const resultsPerPage = 10;
    const pages = Math.ceil(depth / resultsPerPage);

    for (let page = 0; page < pages && results.length < depth; page++) {
        const params = new URLSearchParams({
            user: credentials.user,
            key: credentials.key,
            query: query,
            page: page.toString(),
            domain: 'ru',
            lr: regionInfo.yandexLr || '225',
            device: 'desktop'
        });

        const searchUrl = `${XMLSTOCK_CONFIG.googleUrl}?${params.toString()}`;

        try {
            console.log(`XMLStock Google request page ${page + 1}/${pages}`);
            const response = await axios.get(searchUrl, { timeout: 30000 });
            const $ = cheerio.load(response.data, { xmlMode: true });

            // Parse XMLStock response (Yandex XML format)
            $('group').each((index, element) => {
                if (results.length >= depth) return false;

                const doc = $(element).find('doc').first();
                const url = doc.find('url').first().text().trim();
                let title = doc.find('title').first().text().trim();
                let snippet = doc.find('passages passage').first().text().trim() ||
                             doc.find('headline').text().trim() || '';

                // Remove hlword tags from title and snippet
                title = title.replace(/<\/?hlword>/g, '');
                snippet = snippet.replace(/<\/?hlword>/g, '');

                if (url && title) {
                    const domain = extractDomain(url);
                    const type = determineContentType(url, title);
                    const cleanTitle = title.replace(/<[^>]*>/g, '');
                    const cleanSnippet = snippet.replace(/<[^>]*>/g, '').substring(0, 300);
                    const sentiment = analyzeSentiment(cleanTitle, cleanSnippet, domain);
                    const comment = generateSentimentExplanation(cleanTitle, cleanSnippet, domain, sentiment);

                    results.push({
                        position: results.length + 1,
                        url: url,
                        title: cleanTitle,
                        snippet: cleanSnippet,
                        domain: domain,
                        sentiment: sentiment,
                        sentimentComment: comment,
                        type: type,
                        ctr: CTR_COEFFICIENTS[results.length + 1] || 0.03
                    });
                }
            });

            // Small delay between pages
            if (page < pages - 1) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }

        } catch (error) {
            console.error(`XMLStock Google error (page ${page}):`, error.message);
            if (error.response) {
                console.error('Response status:', error.response.status);
                console.error('Response data:', error.response.data?.substring?.(0, 500));
            }
        }
    }

    return results;
}

// XMLStock Yandex API parser
async function parseYandexXmlStock(query, depth, region) {
    const results = [];
    const credentials = getXmlStockCredentials();

    if (!credentials.user || !credentials.key) {
        console.error('XMLStock credentials not configured');
        return results;
    }

    const regionInfo = REGIONS[region] || REGIONS['ru'];
    const resultsPerPage = 10;
    const pages = Math.ceil(depth / resultsPerPage);

    for (let page = 0; page < pages && results.length < depth; page++) {
        const params = new URLSearchParams({
            user: credentials.user,
            key: credentials.key,
            query: query,
            page: page.toString(),
            lr: regionInfo.yandexLr || '225',
            l10n: 'ru',
            sortby: 'rlv',
            filter: 'none',
            groupby: `attr=d.mode=deep.groups-on-page=${resultsPerPage}.docs-in-group=1`
        });

        const searchUrl = `${XMLSTOCK_CONFIG.yandexUrl}?${params.toString()}`;

        try {
            console.log(`XMLStock Yandex request page ${page + 1}/${pages}`);
            const response = await axios.get(searchUrl, { timeout: 30000 });
            const $ = cheerio.load(response.data, { xmlMode: true });

            // Parse Yandex XML response
            $('group').each((index, element) => {
                if (results.length >= depth) return false;

                const doc = $(element).find('doc').first();
                const url = doc.find('url').first().text().trim();
                let title = doc.find('title').first().text().trim();
                let snippet = doc.find('passages passage').first().text().trim() ||
                             doc.find('headline').text().trim() || '';

                // Remove hlword tags from title and snippet
                title = title.replace(/<\/?hlword>/g, '');
                snippet = snippet.replace(/<\/?hlword>/g, '');

                if (url && title) {
                    const domain = extractDomain(url);
                    const type = determineContentType(url, title);
                    const cleanTitle = title.replace(/<[^>]*>/g, '');
                    const cleanSnippet = snippet.replace(/<[^>]*>/g, '').substring(0, 300);
                    const sentiment = analyzeSentiment(cleanTitle, cleanSnippet, domain);
                    const comment = generateSentimentExplanation(cleanTitle, cleanSnippet, domain, sentiment);

                    results.push({
                        position: results.length + 1,
                        url: url,
                        title: cleanTitle,
                        snippet: cleanSnippet,
                        domain: domain,
                        sentiment: sentiment,
                        sentimentComment: comment,
                        type: type,
                        ctr: CTR_COEFFICIENTS[results.length + 1] || 0.03
                    });
                }
            });

            // Small delay between pages
            if (page < pages - 1) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }

        } catch (error) {
            console.error(`XMLStock Yandex error (page ${page}):`, error.message);
            if (error.response) {
                console.error('Response status:', error.response.status);
                console.error('Response data:', error.response.data?.substring?.(0, 500));
            }
        }
    }

    return results;
}

// Main search function - XMLStock API
async function realSearch(query, engine, depth, region = 'ru') {
    console.log(`Starting XMLStock search: engine=${engine}, query="${query}", depth=${depth}, region=${region}`);

    const credentials = getXmlStockCredentials();
    if (!credentials.user || !credentials.key) {
        console.error('XMLStock API credentials not set! Configure in /api/config or set XMLSTOCK_USER and XMLSTOCK_KEY env vars');
        return [];
    }

    let results = [];

    try {
        if (engine === 'google') {
            results = await parseGoogleXmlStock(query, depth, region);
        } else if (engine === 'yandex') {
            results = await parseYandexXmlStock(query, depth, region);
        }
    } catch (error) {
        console.error(`Search error for ${engine}:`, error.message);
    }

    console.log(`Got ${results.length}/${depth} results from ${engine}`);

    // Ensure positions are correct
    results = results.map((r, i) => ({
        ...r,
        position: i + 1,
        ctr: CTR_COEFFICIENTS[i + 1] || 0.03
    }));

    // Apply Claude sentiment analysis if enabled
    const config = loadConfig();
    if (config.useClaude && config.claudeApiKey && results.length > 0) {
        console.log(`[Sentiment] Applying Claude analysis to ${results.length} results...`);
        try {
            results = await analyzeSentimentBatch(results);
            console.log('[Sentiment] Claude analysis completed');
        } catch (error) {
            console.error('[Sentiment] Claude batch analysis error:', error.message);
        }
    }

    return results;
}

// Real search with progress callback for background parsing
async function realSearchWithProgress(query, engine, depth, region = 'ru', onProgress = null) {
    console.log(`Starting XMLStock search: engine=${engine}, query="${query}", depth=${depth}, region=${region}`);

    const credentials = getXmlStockCredentials();
    if (!credentials.user || !credentials.key) {
        console.error('XMLStock API credentials not set!');
        return [];
    }

    let results = [];

    try {
        if (onProgress) onProgress(0.1, 'Подключение к API...');

        if (engine === 'google') {
            results = await parseGoogleXmlStockWithProgress(query, depth, region, onProgress);
        } else if (engine === 'yandex') {
            results = await parseYandexXmlStockWithProgress(query, depth, region, onProgress);
        }
    } catch (error) {
        console.error(`Search error for ${engine}:`, error.message);
    }

    console.log(`Got ${results.length}/${depth} results from ${engine}`);

    // Ensure positions are correct
    results = results.map((r, i) => ({
        ...r,
        position: i + 1,
        ctr: CTR_COEFFICIENTS[i + 1] || 0.03
    }));

    if (onProgress) onProgress(0.5, 'Анализ тональности...');

    // Apply Claude sentiment analysis if enabled
    const config = loadConfig();
    if (config.useClaude && config.claudeApiKey && results.length > 0) {
        console.log(`[Sentiment] Applying Claude analysis to ${results.length} results...`);
        try {
            results = await analyzeSentimentBatchWithProgress(results, (progress, step) => {
                if (onProgress) onProgress(0.5 + progress * 0.5, step);
            });
            console.log('[Sentiment] Claude analysis completed');
        } catch (error) {
            console.error('[Sentiment] Claude batch analysis error:', error.message);
        }
    } else {
        // Local sentiment analysis
        if (onProgress) onProgress(0.8, 'Локальный анализ...');
        results = results.map(item => ({
            ...item,
            sentiment: analyzeSentiment(item.title, item.snippet),
            sentimentExplanation: 'Локальный анализ',
            sentimentConfidence: 0.5
        }));
    }

    if (onProgress) onProgress(1, 'Поиск завершен');
    return results;
}

// Google parsing with progress
async function parseGoogleXmlStockWithProgress(query, depth, region, onProgress) {
    const results = [];
    const credentials = getXmlStockCredentials();

    if (!credentials.user || !credentials.key) {
        console.error('XMLStock credentials not configured');
        return results;
    }

    const regionInfo = REGIONS[region] || REGIONS['ru'];
    const resultsPerPage = 10;
    const pages = Math.ceil(depth / resultsPerPage);

    for (let page = 0; page < pages && results.length < depth; page++) {
        if (onProgress) {
            const progress = 0.1 + (page / pages) * 0.4;
            onProgress(progress, `Страница ${page + 1}/${pages}...`);
        }

        const params = new URLSearchParams({
            user: credentials.user,
            key: credentials.key,
            query: query,
            page: page.toString(),
            domain: 'ru',
            lr: regionInfo.yandexLr || '225',
            device: 'desktop'
        });

        const searchUrl = `${XMLSTOCK_CONFIG.googleUrl}?${params.toString()}`;

        try {
            console.log(`XMLStock Google request page ${page + 1}/${pages}`);
            const response = await axios.get(searchUrl, { timeout: 30000 });
            const $ = cheerio.load(response.data, { xmlMode: true });

            // Parse XMLStock response
            $('group').each((index, element) => {
                if (results.length >= depth) return false;

                const doc = $(element).find('doc').first();
                const url = doc.find('url').first().text().trim();
                let title = doc.find('title').first().text().trim();
                let snippet = doc.find('passages passage').first().text().trim() ||
                             doc.find('headline').text().trim() || '';

                // Remove hlword tags
                title = title.replace(/<\/?hlword>/g, '');
                snippet = snippet.replace(/<\/?hlword>/g, '');

                if (url && title) {
                    const domain = extractDomain(url);
                    const type = determineContentType(url, title);
                    const cleanTitle = title.replace(/<[^>]*>/g, '');
                    const cleanSnippet = snippet.replace(/<[^>]*>/g, '').substring(0, 300);

                    results.push({
                        position: results.length + 1,
                        url: url,
                        title: cleanTitle,
                        snippet: cleanSnippet,
                        domain: domain,
                        type: type
                    });
                }
            });

            if (page < pages - 1) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }

        } catch (error) {
            console.error(`XMLStock Google error (page ${page}):`, error.message);
        }
    }

    return results;
}

// Yandex parsing with progress
async function parseYandexXmlStockWithProgress(query, depth, region, onProgress) {
    const results = [];
    const credentials = getXmlStockCredentials();

    if (!credentials.user || !credentials.key) {
        console.error('XMLStock credentials not configured');
        return results;
    }

    const regionInfo = REGIONS[region] || REGIONS['ru'];
    const resultsPerPage = 10;
    const pages = Math.ceil(depth / resultsPerPage);

    for (let page = 0; page < pages && results.length < depth; page++) {
        if (onProgress) {
            const progress = 0.1 + (page / pages) * 0.4;
            onProgress(progress, `Страница ${page + 1}/${pages}...`);
        }

        const params = new URLSearchParams({
            user: credentials.user,
            key: credentials.key,
            query: query,
            page: page.toString(),
            lr: regionInfo.yandexLr || '225',
            l10n: 'ru',
            sortby: 'rlv',
            filter: 'none',
            groupby: `attr=d.mode=deep.groups-on-page=${resultsPerPage}.docs-in-group=1`
        });

        const searchUrl = `${XMLSTOCK_CONFIG.yandexUrl}?${params.toString()}`;

        try {
            console.log(`XMLStock Yandex request page ${page + 1}/${pages}`);
            const response = await axios.get(searchUrl, { timeout: 30000 });
            const $ = cheerio.load(response.data, { xmlMode: true });

            // Parse Yandex XML response
            $('group').each((index, element) => {
                if (results.length >= depth) return false;

                const doc = $(element).find('doc').first();
                const url = doc.find('url').first().text().trim();
                let title = doc.find('title').first().text().trim();
                let snippet = doc.find('passages passage').first().text().trim() ||
                             doc.find('headline').text().trim() || '';

                // Remove hlword tags
                title = title.replace(/<\/?hlword>/g, '');
                snippet = snippet.replace(/<\/?hlword>/g, '');

                if (url && title) {
                    const domain = extractDomain(url);
                    const type = determineContentType(url, title);
                    const cleanTitle = title.replace(/<[^>]*>/g, '');
                    const cleanSnippet = snippet.replace(/<[^>]*>/g, '').substring(0, 300);

                    results.push({
                        position: results.length + 1,
                        url: url,
                        title: cleanTitle,
                        snippet: cleanSnippet,
                        domain: domain,
                        type: type
                    });
                }
            });

            if (page < pages - 1) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }

        } catch (error) {
            console.error(`XMLStock Yandex error (page ${page}):`, error.message);
        }
    }

    return results;
}

// Sentiment batch with progress
async function analyzeSentimentBatchWithProgress(items, onProgress = null) {
    const client = getAnthropicClient();
    const config = loadConfig();

    // If Claude not configured - use local analysis
    if (!client || !config.useClaude) {
        return items.map(item => ({
            ...item,
            sentiment: analyzeSentiment(item.title, item.snippet),
            sentimentExplanation: 'Локальный анализ',
            sentimentConfidence: 0.5
        }));
    }

    const results = [];
    const total = items.length;

    for (let i = 0; i < items.length; i++) {
        const item = items[i];

        if (onProgress) {
            const progress = i / total;
            onProgress(progress, `Анализ ${i + 1}/${total}...`);
        }

        try {
            const analysis = await analyzeSentimentWithClaude(item.title, item.snippet, item.url);
            results.push({
                ...item,
                sentiment: analysis.sentiment,
                sentimentComment: analysis.explanation,
                sentimentConfidence: analysis.confidence
            });
        } catch (error) {
            // Fallback to local
            results.push({
                ...item,
                sentiment: analyzeSentiment(item.title, item.snippet),
                sentimentComment: 'Локальный анализ (ошибка API)',
                sentimentConfidence: 0.3
            });
        }
    }

    if (onProgress) onProgress(1, 'Анализ завершен');
    return results;
}

// Calculate metrics with progress (wrapper)
async function calculateMetricsWithProgress(results, onProgress = null) {
    if (onProgress) onProgress(0, 'Расчет метрик...');
    const metrics = calculateMetrics(results);
    if (onProgress) onProgress(1, 'Метрики рассчитаны');
    return metrics;
}

// Calculate CTR-weighted metrics with new formula
// Positive: +CTR × 1, Neutral: +CTR × 0.75, Negative: -CTR × 1
// Rating range: 0 (all negative) to 100 (all positive), 87.5 (all neutral)
function calculateMetrics(results) {
    // Only use top 10 for rating calculation
    const top10 = results.slice(0, 10);

    let positiveWeight = 0;
    let negativeWeight = 0;
    let neutralWeight = 0;
    let totalCTR = 0;
    let score = 0;

    top10.forEach(result => {
        totalCTR += result.ctr;
        if (result.sentiment === 'positive') {
            positiveWeight += result.ctr;
            score += result.ctr * 1;     // Позитив: +CTR × 1
        } else if (result.sentiment === 'negative') {
            negativeWeight += result.ctr;
            score -= result.ctr * 1;     // Негатив: -CTR × 1
        } else {
            neutralWeight += result.ctr;
            score += result.ctr * 0.75;  // Нейтрал: +CTR × 0.75
        }
    });

    // Convert score from (-100..100) to (0..100)
    // -100 -> 0, 0 -> 50, +100 -> 100
    const rating = (score + 100) / 2;

    // Risk level based on negative weight in top 10
    const negativeRatio = negativeWeight / totalCTR;

    return {
        totalResults: results.length,
        positiveCount: results.filter(r => r.sentiment === 'positive').length,
        negativeCount: results.filter(r => r.sentiment === 'negative').length,
        neutralCount: results.filter(r => r.sentiment === 'neutral').length,
        positivePercent: totalCTR > 0 ? ((positiveWeight / totalCTR) * 100).toFixed(1) : '0.0',
        negativePercent: totalCTR > 0 ? ((negativeWeight / totalCTR) * 100).toFixed(1) : '0.0',
        neutralPercent: totalCTR > 0 ? ((neutralWeight / totalCTR) * 100).toFixed(1) : '0.0',
        rating: rating.toFixed(1),
        balance: rating.toFixed(1), // deprecated, use rating
        score: score.toFixed(1),
        riskLevel: negativeRatio > 0.5 ? 'high' : negativeRatio > 0.3 ? 'medium' : 'low'
    };
}

// API Routes

// Get available regions
app.get('/api/regions', (req, res) => {
    res.json(getRegions());
});

// Get XMLStock config (without exposing full key)
app.get('/api/config', (req, res) => {
    const credentials = getXmlStockCredentials();
    res.json({
        xmlstock: {
            user: credentials.user,
            keySet: !!credentials.key,
            keyPreview: credentials.key ? credentials.key.substring(0, 8) + '...' : ''
        }
    });
});

// Get XMLStock balance
app.get('/api/config/xmlstock/balance', asyncHandler(async (req, res) => {
    const credentials = getXmlStockCredentials();

    if (!credentials.user || !credentials.key) {
        return res.status(400).json({ error: 'XMLStock API not configured' });
    }

    try {
        const response = await axios.get(`https://xmlstock.com/api/`, {
            params: {
                user: credentials.user,
                key: credentials.key
            },
            timeout: 10000
        });

        // Response: {"limits":0,"limits-freeze":0,"outgo-month":0,"outgo-day":0,"balance":833.59,"balance-freeze":0,"days":0}
        const data = response.data;

        res.json({
            balance: data.balance || 0,
            balanceFreeze: data['balance-freeze'] || 0,
            limits: data.limits || 0,
            outgoMonth: data['outgo-month'] || 0,
            outgoDay: data['outgo-day'] || 0,
            currency: 'RUB'
        });
    } catch (error) {
        console.error('XMLStock balance error:', error.message);
        res.status(500).json({ error: 'Failed to fetch XMLStock balance', details: error.message });
    }
}));

// Update XMLStock config
app.post('/api/config', (req, res) => {
    const { user, key } = req.body;

    if (!user || !key) {
        return res.status(400).json({ error: 'User ID and API key are required' });
    }

    const config = loadConfig();
    config.xmlstock = { user, key };
    saveConfig(config);

    res.json({ success: true, message: 'XMLStock credentials saved' });
});

// Get Claude API config
app.get('/api/config/claude', (req, res) => {
    const config = loadConfig();
    res.json({
        keySet: !!config.claudeApiKey,
        keyPreview: config.claudeApiKey ? config.claudeApiKey.substring(0, 12) + '...' : '',
        useClaude: config.useClaude || false
    });
});

// Update Claude API config
app.post('/api/config/claude', (req, res) => {
    const { apiKey, useClaude } = req.body;

    const config = loadConfig();

    if (apiKey !== undefined) {
        config.claudeApiKey = apiKey;
        resetAnthropicClient(); // Reset client to use new key
    }

    if (useClaude !== undefined) {
        config.useClaude = useClaude;
    }

    saveConfig(config);

    res.json({
        success: true,
        message: 'Claude API settings saved',
        keySet: !!config.claudeApiKey,
        useClaude: config.useClaude
    });
});

// Test Claude API connection
app.post('/api/config/claude/test', asyncHandler(async (req, res) => {
    const config = loadConfig();

    if (!config.claudeApiKey) {
        return res.status(400).json({ error: 'Claude API key not configured' });
    }

    try {
        resetAnthropicClient();
        const result = await analyzeSentimentWithClaude(
            'Компания показала отличные результаты',
            'Выручка выросла на 50%, клиенты довольны сервисом',
            'https://example.com/test'
        );

        res.json({
            success: true,
            message: 'Claude API работает корректно',
            testResult: result
        });
    } catch (error) {
        res.status(500).json({
            error: 'Ошибка подключения к Claude API',
            details: error.message
        });
    }
}));

// Get all projects
app.get('/api/projects', (req, res) => {
    const projects = loadProjects();
    res.json(projects);
});

// Create project
app.post('/api/projects', (req, res) => {
    const { name, region } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Project name is required' });
    }

    const projects = loadProjects();
    const newProject = {
        id: uuidv4(),
        name,
        region: region || 'ru',
        createdAt: new Date().toISOString(),
        entities: []
    };

    projects.push(newProject);
    saveProjects(projects);
    res.json(newProject);
});

// Get project by ID
app.get('/api/projects/:projectId', (req, res) => {
    const projects = loadProjects();
    const project = projects.find(p => p.id === req.params.projectId);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    res.json(project);
});

// Delete project
app.delete('/api/projects/:projectId', (req, res) => {
    let projects = loadProjects();
    projects = projects.filter(p => p.id !== req.params.projectId);
    saveProjects(projects);
    res.json({ success: true });
});

// Create entity in project
app.post('/api/projects/:projectId/entities', (req, res) => {
    const { name, engines, depth } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Entity name (keyword) is required' });
    }

    const projects = loadProjects();
    const project = projects.find(p => p.id === req.params.projectId);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    const newEntity = {
        id: uuidv4(),
        name,
        engines: engines || ['google', 'yandex'],
        depth: depth || 20,
        createdAt: new Date().toISOString(),
        parsings: []
    };

    project.entities.push(newEntity);
    saveProjects(projects);
    res.json(newEntity);
});

// Get entity
app.get('/api/projects/:projectId/entities/:entityId', (req, res) => {
    const projects = loadProjects();
    const project = projects.find(p => p.id === req.params.projectId);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    const entity = project.entities.find(e => e.id === req.params.entityId);

    if (!entity) {
        return res.status(404).json({ error: 'Entity not found' });
    }

    res.json(entity);
});

// Update entity settings (depth, engines)
app.patch('/api/projects/:projectId/entities/:entityId', (req, res) => {
    const { depth, engines } = req.body;

    const projects = loadProjects();
    const project = projects.find(p => p.id === req.params.projectId);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    const entity = project.entities.find(e => e.id === req.params.entityId);

    if (!entity) {
        return res.status(404).json({ error: 'Entity not found' });
    }

    // Update depth if provided
    if (depth !== undefined) {
        const validDepths = [10, 20, 50, 100];
        if (validDepths.includes(parseInt(depth))) {
            entity.depth = parseInt(depth);
        }
    }

    // Update engines if provided
    if (engines !== undefined && Array.isArray(engines) && engines.length > 0) {
        entity.engines = engines.filter(e => ['google', 'yandex'].includes(e));
    }

    saveProjects(projects);
    res.json(entity);
});

// Delete entity
app.delete('/api/projects/:projectId/entities/:entityId', (req, res) => {
    const projects = loadProjects();
    const project = projects.find(p => p.id === req.params.projectId);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    project.entities = project.entities.filter(e => e.id !== req.params.entityId);
    saveProjects(projects);
    res.json({ success: true });
});

// Run parsing for entity (wrapped with asyncHandler for error safety)
app.post('/api/projects/:projectId/entities/:entityId/parse', asyncHandler(async (req, res) => {
    const { region } = req.body;
    const selectedRegion = region || 'ru';

    const projects = loadProjects();
    const project = projects.find(p => p.id === req.params.projectId);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    const entity = project.entities.find(e => e.id === req.params.entityId);

    if (!entity) {
        return res.status(404).json({ error: 'Entity not found' });
    }

    const regionInfo = REGIONS[selectedRegion] || REGIONS['ru'];

    const parsingResults = {
        id: uuidv4(),
        date: new Date().toISOString(),
        region: {
            code: regionInfo.code,
            name: regionInfo.name
        },
        engines: {}
    };

    // Run parsing for each engine
    for (const engine of entity.engines) {
        const results = await realSearch(entity.name, engine, entity.depth, selectedRegion);
        const metrics = calculateMetrics(results);

        parsingResults.engines[engine] = {
            results,
            metrics
        };
    }

    entity.parsings.push(parsingResults);
    saveProjects(projects);

    res.json(parsingResults);
}));

// Start background parsing for entity
app.post('/api/projects/:projectId/entities/:entityId/parse-background', asyncHandler(async (req, res) => {
    const { region } = req.body;
    const { projectId, entityId } = req.params;

    const projects = loadProjects();
    const project = projects.find(p => p.id === projectId);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    const entity = project.entities.find(e => e.id === entityId);

    if (!entity) {
        return res.status(404).json({ error: 'Entity not found' });
    }

    // Use provided region, or project region, or default to 'ru'
    const selectedRegion = region || project.region || 'ru';

    // Check if parsing already running for this entity
    for (const [taskId, task] of activeParsings) {
        if (task.entityId === entityId && task.status === 'running') {
            return res.json({ taskId, alreadyRunning: true });
        }
    }

    const taskId = uuidv4();
    const regionInfo = REGIONS[selectedRegion] || REGIONS['ru'];
    const totalSteps = entity.engines.length * 2 + 1; // search + sentiment for each engine + save

    // Initialize task
    activeParsings.set(taskId, {
        projectId,
        entityId,
        entityName: entity.name,
        status: 'running',
        progress: 0,
        currentStep: 'Инициализация...',
        totalSteps,
        completedSteps: 0,
        result: null,
        error: null,
        startedAt: new Date().toISOString()
    });

    // Start background parsing
    (async () => {
        const task = activeParsings.get(taskId);
        try {
            const parsingResults = {
                id: uuidv4(),
                date: new Date().toISOString(),
                region: {
                    code: regionInfo.code,
                    name: regionInfo.name
                },
                engines: {}
            };

            let completedSteps = 0;
            const engineCount = entity.engines.length;

            // Run parsing for each engine
            for (let engineIndex = 0; engineIndex < entity.engines.length; engineIndex++) {
                const engine = entity.engines[engineIndex];
                const engineName = engine === 'google' ? 'Google' : 'Яндекс';

                // Progress callback for detailed updates
                const updateProgress = (subStep, subProgress) => {
                    // Each engine has 2 main steps (search + analysis)
                    // Calculate overall progress based on engine index and sub-step
                    const engineWeight = 1 / engineCount;
                    const baseProgress = engineIndex * engineWeight;
                    const stepProgress = (subStep + subProgress) * engineWeight / 2;
                    task.progress = Math.round((baseProgress + stepProgress) * 100);
                    task.completedSteps = completedSteps;
                };

                // Step 1: Search
                task.currentStep = `Поиск в ${engineName}...`;
                updateProgress(0, 0);

                const results = await realSearchWithProgress(
                    entity.name,
                    engine,
                    entity.depth,
                    selectedRegion,
                    (searchProgress, searchStep) => {
                        task.currentStep = `${engineName}: ${searchStep}`;
                        updateProgress(0, searchProgress);
                    }
                );
                completedSteps++;
                updateProgress(1, 0);

                // Step 2: Sentiment analysis
                task.currentStep = `Анализ тональности ${engineName}...`;

                const metrics = await calculateMetricsWithProgress(
                    results,
                    (analysisProgress, analysisStep) => {
                        task.currentStep = `${engineName}: ${analysisStep}`;
                        updateProgress(1, analysisProgress);
                    }
                );
                completedSteps++;
                updateProgress(2, 0);

                parsingResults.engines[engine] = {
                    results,
                    metrics
                };
            }

            // Step 3: Save results
            task.currentStep = 'Сохранение результатов...';

            // Reload projects to get fresh data
            const freshProjects = loadProjects();
            const freshProject = freshProjects.find(p => p.id === projectId);
            const freshEntity = freshProject?.entities.find(e => e.id === entityId);

            if (freshEntity) {
                freshEntity.parsings.push(parsingResults);
                saveProjects(freshProjects);
            }

            completedSteps++;
            task.completedSteps = completedSteps;
            task.progress = 100;
            task.status = 'completed';
            task.currentStep = 'Завершено';
            task.result = parsingResults;
            task.completedAt = new Date().toISOString();

            console.log(`[Background Parsing] Task ${taskId} completed for entity ${entity.name}`);

        } catch (error) {
            console.error(`[Background Parsing] Task ${taskId} failed:`, error);
            task.status = 'error';
            task.error = error.message;
            task.currentStep = 'Ошибка';
        }

        // Clean up old tasks after 5 minutes
        setTimeout(() => {
            activeParsings.delete(taskId);
        }, 5 * 60 * 1000);
    })();

    res.json({ taskId, status: 'started' });
}));

// Get parsing task status
app.get('/api/parsing-tasks/:taskId', (req, res) => {
    const task = activeParsings.get(req.params.taskId);

    if (!task) {
        return res.status(404).json({ error: 'Task not found or expired' });
    }

    res.json(task);
});

// Get all active parsing tasks
app.get('/api/parsing-tasks', (req, res) => {
    const tasks = [];
    for (const [taskId, task] of activeParsings) {
        tasks.push({ taskId, ...task });
    }
    res.json(tasks);
});

// Get parsing comparison
app.get('/api/projects/:projectId/entities/:entityId/compare', (req, res) => {
    const { parsingIds } = req.query;

    const projects = loadProjects();
    const project = projects.find(p => p.id === req.params.projectId);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    const entity = project.entities.find(e => e.id === req.params.entityId);

    if (!entity) {
        return res.status(404).json({ error: 'Entity not found' });
    }

    let parsingsToCompare = entity.parsings;

    if (parsingIds) {
        const ids = parsingIds.split(',');
        parsingsToCompare = entity.parsings.filter(p => ids.includes(p.id));
    }

    // Calculate comparison data
    const comparison = {
        parsings: parsingsToCompare,
        trends: {}
    };

    // Calculate trends for each engine
    const engines = [...new Set(parsingsToCompare.flatMap(p => Object.keys(p.engines)))];

    engines.forEach(engine => {
        comparison.trends[engine] = {
            dates: [],
            positivePercent: [],
            negativePercent: [],
            balance: []
        };

        parsingsToCompare.forEach(parsing => {
            if (parsing.engines[engine]) {
                comparison.trends[engine].dates.push(parsing.date);
                comparison.trends[engine].positivePercent.push(parseFloat(parsing.engines[engine].metrics.positivePercent));
                comparison.trends[engine].negativePercent.push(parseFloat(parsing.engines[engine].metrics.negativePercent));
                comparison.trends[engine].balance.push(parseFloat(parsing.engines[engine].metrics.balance));
            }
        });
    });

    res.json(comparison);
});

// Delete parsing from history
app.delete('/api/projects/:projectId/entities/:entityId/parsings/:parsingId', (req, res) => {
    const projects = loadProjects();
    const project = projects.find(p => p.id === req.params.projectId);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    const entity = project.entities.find(e => e.id === req.params.entityId);

    if (!entity) {
        return res.status(404).json({ error: 'Entity not found' });
    }

    const parsingIndex = entity.parsings.findIndex(p => p.id === req.params.parsingId);

    if (parsingIndex === -1) {
        return res.status(404).json({ error: 'Parsing not found' });
    }

    entity.parsings.splice(parsingIndex, 1);
    saveProjects(projects);

    res.json({ success: true });
});

// Update result sentiment manually
app.patch('/api/projects/:projectId/entities/:entityId/parsings/:parsingId/results/:position', (req, res) => {
    const { engine, sentiment } = req.body;

    const projects = loadProjects();
    const project = projects.find(p => p.id === req.params.projectId);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    const entity = project.entities.find(e => e.id === req.params.entityId);

    if (!entity) {
        return res.status(404).json({ error: 'Entity not found' });
    }

    const parsing = entity.parsings.find(p => p.id === req.params.parsingId);

    if (!parsing) {
        return res.status(404).json({ error: 'Parsing not found' });
    }

    const position = parseInt(req.params.position);
    const result = parsing.engines[engine]?.results.find(r => r.position === position);

    if (!result) {
        return res.status(404).json({ error: 'Result not found' });
    }

    result.sentiment = sentiment;

    // Recalculate metrics
    parsing.engines[engine].metrics = calculateMetrics(parsing.engines[engine].results);

    saveProjects(projects);
    res.json(parsing);
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    const credentials = getXmlStockCredentials();
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        xmlstockConfigured: !!(credentials.user && credentials.key),
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
        }
    });
});

// Bulk Search History Management
const BULK_SEARCH_HISTORY_FILE = path.join(DATA_DIR, 'bulk-search-history.json');

function loadBulkSearchHistory() {
    try {
        if (fs.existsSync(BULK_SEARCH_HISTORY_FILE)) {
            return JSON.parse(fs.readFileSync(BULK_SEARCH_HISTORY_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('Error loading bulk search history:', error);
    }
    return [];
}

function saveBulkSearchHistory(history) {
    fs.writeFileSync(BULK_SEARCH_HISTORY_FILE, JSON.stringify(history, null, 2));
}

// Get bulk search history list
app.get('/api/bulk-search/history', (req, res) => {
    const history = loadBulkSearchHistory();
    // Return summary without full results for listing
    const summary = history.map(item => ({
        id: item.id,
        timestamp: item.timestamp,
        searchDepth: item.searchDepth,
        queriesCount: item.queriesCount,
        targetUrlsCount: item.targetUrlsCount,
        foundCount: item.foundCount,
        notFoundCount: item.notFoundCount
    }));
    res.json(summary);
});

// Get specific bulk search result by ID
app.get('/api/bulk-search/history/:id', (req, res) => {
    const history = loadBulkSearchHistory();
    const item = history.find(h => h.id === req.params.id);
    if (item) {
        res.json(item);
    } else {
        res.status(404).json({ error: 'Bulk search result not found' });
    }
});

// Delete bulk search from history
app.delete('/api/bulk-search/history/:id', (req, res) => {
    let history = loadBulkSearchHistory();
    const initialLength = history.length;
    history = history.filter(h => h.id !== req.params.id);
    if (history.length < initialLength) {
        saveBulkSearchHistory(history);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Bulk search result not found' });
    }
});

// Get current bulk search status
let bulkSearchStatus = { running: false, progress: null };

app.get('/api/bulk-search/status', (req, res) => {
    res.json(bulkSearchStatus);
});

// Start new bulk search
app.post('/api/bulk-search/start', asyncHandler(async (req, res) => {
    const { queries, targetUrls, depth = 100 } = req.body;

    if (!queries || !Array.isArray(queries) || queries.length === 0) {
        return res.status(400).json({ error: 'Queries array is required' });
    }
    if (!targetUrls || !Array.isArray(targetUrls) || targetUrls.length === 0) {
        return res.status(400).json({ error: 'Target URLs array is required' });
    }

    if (bulkSearchStatus.running) {
        return res.status(409).json({ error: 'Bulk search is already running' });
    }

    const searchId = uuidv4();
    bulkSearchStatus = {
        running: true,
        progress: { current: 0, total: queries.length, query: '' },
        searchId: searchId
    };

    // Run bulk search in background
    runBulkSearch(searchId, queries, targetUrls, depth).catch(err => {
        console.error('Bulk search error:', err);
        bulkSearchStatus = { running: false, progress: null, error: err.message };
    });

    res.json({
        message: 'Bulk search started',
        searchId: searchId,
        queriesCount: queries.length,
        targetUrlsCount: targetUrls.length,
        depth: depth
    });
}));

// Simple Yandex parser for bulk search (no sentiment analysis - faster)
async function parseYandexForBulk(query, depth) {
    const results = [];
    const credentials = getXmlStockCredentials();

    if (!credentials.user || !credentials.key) {
        return results;
    }

    const resultsPerPage = 10;
    const pages = Math.ceil(depth / resultsPerPage);

    for (let page = 0; page < pages && results.length < depth; page++) {
        const params = new URLSearchParams({
            user: credentials.user,
            key: credentials.key,
            query: query,
            page: page.toString(),
            lr: '225',
            l10n: 'ru',
            sortby: 'rlv',
            filter: 'none',
            groupby: `attr=d.mode=deep.groups-on-page=${resultsPerPage}.docs-in-group=1`
        });

        const searchUrl = `${XMLSTOCK_CONFIG.yandexUrl}?${params.toString()}`;

        try {
            const response = await axios.get(searchUrl, { timeout: 30000 });
            const $ = cheerio.load(response.data, { xmlMode: true });

            $('group').each((index, element) => {
                if (results.length >= depth) return false;

                const doc = $(element).find('doc').first();
                const url = doc.find('url').first().text().trim();
                let title = doc.find('title').first().text().trim();

                title = title.replace(/<\/?hlword>/g, '').replace(/<[^>]*>/g, '');

                if (url && title) {
                    results.push({
                        position: results.length + 1,
                        url: url,
                        title: title
                    });
                }
            });

            if (page < pages - 1) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        } catch (error) {
            console.error(`[BULK] Yandex error (page ${page}):`, error.message);
        }
    }

    return results;
}

// Bulk search runner function
async function runBulkSearch(searchId, queries, targetUrls, depth) {
    const credentials = getXmlStockCredentials();
    if (!credentials.user || !credentials.key) {
        throw new Error('XMLStock credentials not configured');
    }

    const allResults = {};
    const foundArticles = {};

    // Initialize found articles tracking
    targetUrls.forEach(url => {
        foundArticles[url] = [];
    });

    // Process each query
    for (let i = 0; i < queries.length; i++) {
        const query = queries[i];
        bulkSearchStatus.progress = {
            current: i + 1,
            total: queries.length,
            query: query
        };

        console.log(`[BULK] [${i + 1}/${queries.length}] "${query}"`);

        // Use simple parser without sentiment analysis
        const results = await parseYandexForBulk(query, depth);
        allResults[query] = results;

        console.log(`[BULK] Got ${results.length} results`);

        // Check for target URLs
        results.forEach(result => {
            const normalizedResult = normalizeUrlForBulk(result.url);

            targetUrls.forEach(targetUrl => {
                const normalizedTarget = normalizeUrlForBulk(targetUrl);

                if (normalizedResult.includes(normalizedTarget) ||
                    normalizedTarget.includes(normalizedResult) ||
                    normalizedResult === normalizedTarget) {
                    foundArticles[targetUrl].push({
                        query: query,
                        position: result.position,
                        actualUrl: result.url
                    });
                }
            });
        });

        // Delay between queries
        if (i < queries.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    // Calculate counts
    let foundCount = 0;
    let notFoundCount = 0;
    targetUrls.forEach(url => {
        if (foundArticles[url].length > 0) {
            foundCount++;
        } else {
            notFoundCount++;
        }
    });

    // Create report
    const report = {
        id: searchId,
        timestamp: new Date().toISOString(),
        searchDepth: depth,
        queriesCount: queries.length,
        queries: queries,
        targetUrlsCount: targetUrls.length,
        targetUrls: targetUrls,
        foundCount: foundCount,
        notFoundCount: notFoundCount,
        foundArticles: foundArticles,
        allResults: allResults
    };

    // Save to history
    const history = loadBulkSearchHistory();
    history.unshift(report); // Add to beginning
    // Keep only last 20 searches
    if (history.length > 20) {
        history.splice(20);
    }
    saveBulkSearchHistory(history);

    // Also save as current results for backward compatibility
    fs.writeFileSync(path.join(DATA_DIR, 'bulk-search-results.json'), JSON.stringify(report, null, 2));

    bulkSearchStatus = { running: false, progress: null, lastSearchId: searchId };
    console.log(`[BULK] Completed: Found ${foundCount}/${targetUrls.length} articles`);

    return report;
}

// Normalize URL for bulk search comparison
function normalizeUrlForBulk(url) {
    try {
        return url.toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .replace(/\/$/, '')
            .replace(/\?.*$/, '');
    } catch {
        return url;
    }
}

// Get bulk search results (legacy endpoint)
app.get('/api/bulk-search-results', (req, res) => {
    const resultsFile = path.join(DATA_DIR, 'bulk-search-results.json');
    try {
        if (fs.existsSync(resultsFile)) {
            const data = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
            res.json(data);
        } else {
            res.status(404).json({ error: 'No bulk search results found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found', path: req.path });
});

// Global error handler - ловит все необработанные ошибки
app.use((err, req, res, next) => {
    console.error('[ERROR]', new Date().toISOString(), req.method, req.path);
    console.error(err.stack || err.message || err);

    // Определяем тип ошибки
    if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        return res.status(503).json({
            error: 'Сервис временно недоступен',
            details: 'Ошибка подключения к внешнему API',
            code: err.code
        });
    }

    if (err.response?.status) {
        return res.status(502).json({
            error: 'Ошибка внешнего API',
            details: `Статус: ${err.response.status}`,
            code: 'EXTERNAL_API_ERROR'
        });
    }

    res.status(500).json({
        error: 'Внутренняя ошибка сервера',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined,
        code: 'INTERNAL_ERROR'
    });
});

// Graceful shutdown handler
const gracefulShutdown = (signal) => {
    console.log(`\n[${signal}] Получен сигнал завершения, закрываем сервер...`);
    server.close(() => {
        console.log('Сервер остановлен корректно');
        process.exit(0);
    });

    // Принудительное завершение через 10 секунд
    setTimeout(() => {
        console.error('Принудительное завершение из-за таймаута');
        process.exit(1);
    }, 10000);
};

// Обработка необработанных ошибок процесса
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', new Date().toISOString());
    console.error(err);
    // Не завершаем процесс, но логируем
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED REJECTION]', new Date().toISOString());
    console.error('Reason:', reason);
});

const server = app.listen(PORT, () => {
    console.log(`SERM Monitor API running on http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/api/health`);
});

// Регистрация обработчиков сигналов
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
