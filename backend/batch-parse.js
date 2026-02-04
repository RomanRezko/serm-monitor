const fs = require('fs');
const axios = require('axios');

const API_URL = 'http://localhost:3001/api';

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const data = JSON.parse(fs.readFileSync('../data/projects.json', 'utf8'));
    const project = data.find(p => p.name === 'КЕ');
    const entitiesWithoutParsings = project.entities.filter(e => !e.parsings || e.parsings.length === 0);

    console.log(`\nНайдено ${entitiesWithoutParsings.length} сущностей без парсингов\n`);

    for (let i = 0; i < entitiesWithoutParsings.length; i++) {
        const entity = entitiesWithoutParsings[i];
        console.log(`[${i + 1}/${entitiesWithoutParsings.length}] Парсинг: ${entity.name}`);

        try {
            const response = await axios.post(
                `${API_URL}/projects/${project.id}/entities/${entity.id}/parse`,
                { region: 'ru' },
                { timeout: 120000 }
            );

            const metrics = response.data.engines?.yandex?.metrics || response.data.engines?.google?.metrics;
            if (metrics) {
                const rating = metrics.rating || ((parseFloat(metrics.balance) + 100) / 2).toFixed(1);
                console.log(`   ✓ Оценка: ${rating} | Позитив: ${metrics.positivePercent}% | Негатив: ${metrics.negativePercent}%`);
            } else {
                console.log(`   ✓ Парсинг завершён`);
            }
        } catch (error) {
            console.log(`   ✗ Ошибка: ${error.message}`);
        }

        // Пауза между запросами
        if (i < entitiesWithoutParsings.length - 1) {
            console.log(`   Пауза 3 сек...`);
            await sleep(3000);
        }
    }

    console.log(`\n✓ Готово! Обработано ${entitiesWithoutParsings.length} сущностей`);
}

main().catch(console.error);
