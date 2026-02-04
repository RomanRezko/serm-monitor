const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

// Load config
const config = JSON.parse(fs.readFileSync('../data/config.json', 'utf8'));
const anthropic = new Anthropic({ apiKey: config.claudeApiKey });

// Load projects
const projectsFile = '../data/projects.json';
let projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
const project = projects.find(p => p.name === 'КЕ');

if (!project) {
    console.error('Проект КЕ не найден');
    process.exit(1);
}

// Deep sentiment analysis with Claude
async function analyzeSentimentDeep(result, query) {
    const prompt = `Ты эксперт по репутационному анализу (SERM). Проанализируй эту публикацию относительно репутации персоны "Кристина Егиазарова".

Поисковый запрос: "${query}"

Публикация:
- URL: ${result.url}
- Домен: ${result.domain}
- Заголовок: ${result.title}
- Описание: ${result.snippet || 'Нет описания'}
- Позиция в выдаче: ${result.position}

ВАЖНО: Анализируй тональность ИМЕННО по отношению к репутации Кристины Егиазаровой, а не к теме в целом.

Критерии оценки:
- POSITIVE: Материал создаёт положительный образ персоны (достижения, профессионализм, благодарности, хорошие отзывы, позитивные публикации)
- NEGATIVE: Материал вредит репутации (критика, скандалы, разоблачения, мошенничество, негативные отзывы, компромат)
- NEUTRAL: Информационный материал без явной оценки (биография без критики, справочная информация, нейтральные упоминания)

Учитывай домен:
- kompromatwiki.org, cryptorussia.ru - как правило негативные источники
- Официальные СМИ (5-tv.ru, rbc.ru) - зависит от контента
- Личные сайты и соцсети - зависит от контента
- Отзывики - зависит от содержания отзывов

Ответь СТРОГО в формате JSON без markdown:
{
  "sentiment": "positive" | "negative" | "neutral",
  "confidence": 0.0-1.0,
  "reasoning": "краткое объяснение оценки на русском (до 150 символов)",
  "impact": "high" | "medium" | "low",
  "keywords": ["ключевые слова из текста, повлиявшие на оценку"]
}`;

    try {
        const response = await anthropic.messages.create({
            model: 'claude-3-haiku-20240307',
            max_tokens: 300,
            messages: [{ role: 'user', content: prompt }]
        });

        const content = response.content[0].text.trim();
        // Parse JSON response
        const parsed = JSON.parse(content);
        return {
            sentiment: parsed.sentiment || 'neutral',
            confidence: parsed.confidence || 0.5,
            reasoning: parsed.reasoning || '',
            impact: parsed.impact || 'medium',
            keywords: parsed.keywords || []
        };
    } catch (error) {
        console.error(`   Ошибка Claude API: ${error.message}`);
        return null;
    }
}

// Sleep function
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Main function
async function main() {
    console.log('='.repeat(60));
    console.log('ГЛУБОКИЙ АНАЛИЗ ТОНАЛЬНОСТИ ЧЕРЕЗ CLAUDE API');
    console.log('='.repeat(60));
    console.log('');

    let totalResults = 0;
    let analyzedResults = 0;
    let changedSentiments = 0;

    // Collect all results to analyze
    const resultsToAnalyze = [];

    for (const entity of project.entities) {
        if (!entity.parsings || entity.parsings.length === 0) continue;

        const latestParsing = entity.parsings[entity.parsings.length - 1];

        for (const engine of Object.keys(latestParsing.engines)) {
            const engineData = latestParsing.engines[engine];
            if (!engineData.results) continue;

            for (const result of engineData.results) {
                totalResults++;
                resultsToAnalyze.push({
                    entity,
                    parsing: latestParsing,
                    engine,
                    result,
                    query: entity.name
                });
            }
        }
    }

    console.log(`Найдено ${totalResults} результатов для анализа\n`);

    // Analyze each result
    for (let i = 0; i < resultsToAnalyze.length; i++) {
        const item = resultsToAnalyze[i];
        const { entity, result, query, engine } = item;

        console.log(`[${i + 1}/${resultsToAnalyze.length}] ${result.domain} (${engine}, pos ${result.position})`);
        console.log(`   Запрос: ${query}`);
        console.log(`   Текущая тональность: ${result.sentiment}`);

        const analysis = await analyzeSentimentDeep(result, query);

        if (analysis) {
            analyzedResults++;
            const oldSentiment = result.sentiment;

            // Update result with deep analysis
            result.sentimentDeep = analysis.sentiment;
            result.sentimentConfidence = analysis.confidence;
            result.sentimentReasoning = analysis.reasoning;
            result.sentimentImpact = analysis.impact;
            result.sentimentKeywords = analysis.keywords;

            // Update main sentiment if confidence is high enough
            if (analysis.confidence >= 0.7) {
                result.sentiment = analysis.sentiment;
            }

            if (oldSentiment !== result.sentiment) {
                changedSentiments++;
                console.log(`   ИЗМЕНЕНО: ${oldSentiment} → ${result.sentiment}`);
            }

            console.log(`   Новая тональность: ${analysis.sentiment} (${(analysis.confidence * 100).toFixed(0)}%)`);
            console.log(`   Причина: ${analysis.reasoning}`);
        }

        console.log('');

        // Rate limiting - 100ms delay between requests
        await sleep(150);

        // Save progress every 50 results
        if ((i + 1) % 50 === 0) {
            fs.writeFileSync(projectsFile, JSON.stringify(projects, null, 2));
            console.log(`[СОХРАНЕНО] Прогресс: ${i + 1}/${resultsToAnalyze.length}`);
            console.log('');
        }
    }

    // Final save
    fs.writeFileSync(projectsFile, JSON.stringify(projects, null, 2));

    console.log('='.repeat(60));
    console.log('ИТОГИ АНАЛИЗА');
    console.log('='.repeat(60));
    console.log(`Всего результатов: ${totalResults}`);
    console.log(`Проанализировано: ${analyzedResults}`);
    console.log(`Изменено тональностей: ${changedSentiments}`);
    console.log('');
    console.log('Данные сохранены в projects.json');
}

main().catch(console.error);
