const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

// XMLStock credentials
const XMLSTOCK = {
    user: '13075',
    key: '3d3a5436f1b1a1f14a6416c609572236',
    yandexUrl: 'https://xmlstock.com/yandex/xml/'
};

// Search queries
const QUERIES = [
    'Кристина Егиазарова',
    'Кристина Егиазарова отзывы',
    'Кристина Егиазарова мнения',
    'Кристина Егиазарова впечатления',
    'Кристина Егиазарова комментарии',
    'Кристина Егиазарова репутация',
    'Кристина Егиазарова мнение людей',
    'Кристина Егиазарова история',
    'Кристина Егиазарова биография отзывы',
    'Кристина Егиазарова негатив',
    'Кристина Егиазарова скандал',
    'Кристина Егиазарова конфликт',
    'Кристина Егиазарова разоблачение',
    'Кристина Егиазарова правда',
    'Кристина Егиазарова критика',
    'Кристина Егиазарова жалоба',
    'Кристина Егиазарова обман',
    'Кристина Егиазарова мошенничество',
    'Кристина Егиазарова отзывы отрицательные',
    'Кристина Егиазарова плохие отзывы',
    'Кристина Егиазарова разоблачение личности',
    'Кристина Егиазарова скандальные истории'
];

// Target URLs to find
const TARGET_URLS = [
    'https://kam24.ru/news/materials/7-mifov-o-kod-fakty-o-kolce-kristiny-egiazarovoy',
    'https://ulpressa.ru/2022/08/26/60-let-nauki-v-5-grammah-hrv-tehnologiya-kod-iz-kosmosa/',
    'https://zavtra.ru/blogs/kol_tco_ne_rabotaet',
    'https://gorod-kimry.ru/zinfo691/12/',
    'https://volga.news/article/774138.html',
    'https://altapress.ru/afisha/story/kristina-egiazarova-put-psikhologa-376456',
    'https://felomena.com/stati/psixologiya/metodiki-raboty-kristiny-egiazarovoj-nauchnyj-podxod-k-psixologii-otnoshenij/',
    'https://ladyadvice.ru/dom/uyut-v-dome/chto-na-samom-dele-proishodit-na-konsultaczii-u-kristiny-egiazarovoj/',
    'https://s-zametki.ru/kristina-egiazarova-otvechaet-na-chastye-voprosy-o-svoej-praktike.html',
    'https://sigolki.com/texnologii-i-nauka/chudo-texniki/professionalnaya-etika-v-rabote-kristiny-egiazarovoj-graniczy-i-princzipy.html',
    'https://kalendarnagod.ru/realnye-istorii-klientov-kristiny-egiazarovoj-kogda-psihologiya-pomogaet/',
    'http://moya-semya.ru/includes/pgs/14/?view_news=kristina-egiazarova-pochemu-hvaljat-i-kritikujut',
    'https://mlady.org/obrazovanie-i-kvalifikacziya-kristiny-egiazarovoj-fakty-bez-prikras/',
    'https://progorod43.ru/podhodit-li-vam-rabota-s-egiazarovoy',
    'https://progorod43.ru/egiazarova-sotseti-i-realnaya-rabota',
    'https://cont.ws/@hexagon/3167565',
    'https://astrakhan.su/news/health/monitoring-sna-s-pomoshhyu-kod-chto-pokazyvayut-dannye-i-kak-ih-ispolzovat/',
    'https://1777.ru/stavropol/stress-i-vosstanovlenie-kod',
    'https://itcrumbs.ru/fitness-treking-kod-vs-braslet_104578',
    'https://bigpicture.ru/rabota-s-travmoy-v-otnosheniyah-egiazarova/',
    'https://tvcenter.ru/dom-i-semya/granitsy-v-otnosheniyah-podhod-kristiny-egiazarovoy/',
    'https://astv.ru/news/materials/kak-kristina-egiazarova-rabotaet-s-parami-v-krizise',
    'https://berkat.ru/articles/260-samoocenka-i-otnoshenija-podhod-kristiny-egiazarovoi.html',
    'https://www.kaluga-poisk.ru/news/novosti-kompanii/onlayn-terapiya-osobennosti-formata-prakticheskie-nablyudeniya-i-opyt-raboty-kristiny-egiazarovoy',
    'https://prochepetsk.ru/psihologiya-deneg-ustanovki-egiazarova',
    'https://www.bragazeta.ru/news/2025/06/09/kak-vybrat-biznes-partnjora-psihologicheskie-kriterii-ot-kristiny-egiazarovoj/',
    'https://unews.pro/news/147483/',
    'https://www.politnavigator.net/vygoranie-predprinimatelya-egiazarova.html',
    'https://stolica-s.su/partners/psihologiya-peregovorov-kak-ne-poddatsya-manipulyacziyam',
    'https://infoniac.ru/panicheskie-ataki-kak-spravitsya-i-vernut-kontrol/',
    'https://www.t24.su/prokrastinatsiya-i-samosabotazh-pochemu-otkladyvaem-vazhnoe/',
    'https://actualnews.org/obshestvo/599333-otnoshenija-s-roditeljami-vo-vzroslom-vozraste-kak-vystroit-granicy.html',
    'https://tvcenter.ru/biografii/biografiya-psihologa-kristina-egiazarova/',
    'https://kam24.ru/news/materials/detalnaya-professionalnaya-biografiya-kristina-egiazarova',
    'https://www.t24.su/kristina-egiazarova-professionalnyy-put-psihologa/',
    'https://news.1777.ru/119944-ekspertiza-v-psihologii-otnosheniy-kristina-egiazarova',
    'https://smolensk-i.ru/partners/kristina-egiazarova-praktika-i-metody-raboty_622715',
    'http://moya-semya.ru/includes/pgs/15/?view_news=kristina-egiazarova-terapiya-podhod',
    'https://www.kaluga-poisk.ru/news/novosti-kompanii/kristina-egiazarova-narrativnaya-biografiya-psihologa',
    'https://daily-inform.ru/kristina-egiazarova-polnaya-biografiya-speczialista.html',
    'https://astrakhan.net/baza-kompanij/meditsina-zdorove-krasota/kristina-egiazarova-psiholog',
    'https://uwoomen.com/advice/psychology/119348-kristina-egiazarova-psiholog-po-rabote-s-parami-i-semejnaya-terapiya.html',
    'https://chehov-vid.ru/news/society/45174/kristina-egiazarova-psikholog-po-rabote-s-samootsenkoy-i-lichnostnym-rostom/?sphrase_id=1100088',
    'https://v-tagile.ru/obschestvo-dekabr-5/kristina-egiazarova-psikholog-po-rabote-s-professionalnym-vygoraniem',
    'https://e-news.su/society/529895-kristina-egiazarova-kak-prohodit-psihoterapija.html',
    'https://www.kaluga-poisk.ru/news/novosti-kompanii/kristina-egiazarova-professionalnaya-etika-psihologa',
    'https://www.kaluga-poisk.ru/news/novosti-kompanii/prosvetitelskaya-deyatelnost-i-publikatsii-kristiny-egiazarovoy',
    'https://1777.ru/stavropol/kristina-egiazarova-rezultaty-priznanie',
    'https://medrybnoe.ru/kristina-egiazarova-sovremennaya-praktika-i-professionalnoe-razvitie.html'
];

// Parse Yandex search results
async function parseYandex(query, depth = 50) {
    const results = [];
    const resultsPerPage = 10;
    const pages = Math.ceil(depth / resultsPerPage);

    for (let page = 0; page < pages && results.length < depth; page++) {
        const params = new URLSearchParams({
            user: XMLSTOCK.user,
            key: XMLSTOCK.key,
            query: query,
            page: page.toString(),
            lr: '225', // Russia
            l10n: 'ru',
            sortby: 'rlv',
            filter: 'none',
            groupby: `attr=d.mode=deep.groups-on-page=${resultsPerPage}.docs-in-group=1`
        });

        const searchUrl = `${XMLSTOCK.yandexUrl}?${params.toString()}`;

        try {
            console.log(`  Page ${page + 1}/${pages}...`);
            const response = await axios.get(searchUrl, { timeout: 30000 });
            const $ = cheerio.load(response.data, { xmlMode: true });

            $('group').each((index, element) => {
                if (results.length >= depth) return false;

                const doc = $(element).find('doc').first();
                const url = doc.find('url').first().text().trim();
                let title = doc.find('title').first().text().trim();

                title = title.replace(/<\/?hlword>/g, '');

                if (url && title) {
                    results.push({
                        position: results.length + 1,
                        url: url,
                        title: title.replace(/<[^>]*>/g, '')
                    });
                }
            });

            // Delay between pages
            if (page < pages - 1) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }

        } catch (error) {
            console.error(`  Error on page ${page}:`, error.message);
        }
    }

    return results;
}

// Normalize URL for comparison
function normalizeUrl(url) {
    try {
        let normalized = url.toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .replace(/\/$/, '')
            .replace(/\?.*$/, '');
        return normalized;
    } catch {
        return url;
    }
}

// Main function
async function main() {
    console.log('='.repeat(60));
    console.log('BULK YANDEX SEARCH - 22 queries x 100 results');
    console.log('='.repeat(60));
    console.log('');

    const allResults = {};
    const foundArticles = {};

    // Initialize found articles tracking
    TARGET_URLS.forEach(url => {
        foundArticles[url] = [];
    });

    // Process each query
    for (let i = 0; i < QUERIES.length; i++) {
        const query = QUERIES[i];
        console.log(`\n[${i + 1}/${QUERIES.length}] "${query}"`);

        const results = await parseYandex(query, 100);
        allResults[query] = results;

        console.log(`  Got ${results.length} results`);

        // Check for target URLs
        results.forEach(result => {
            const normalizedResult = normalizeUrl(result.url);

            TARGET_URLS.forEach(targetUrl => {
                const normalizedTarget = normalizeUrl(targetUrl);

                // Check if URLs match (partial match for flexibility)
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
        if (i < QUERIES.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    // Generate report
    console.log('\n');
    console.log('='.repeat(60));
    console.log('REPORT: Found articles from the list');
    console.log('='.repeat(60));

    let foundCount = 0;
    let notFoundCount = 0;

    TARGET_URLS.forEach(url => {
        const found = foundArticles[url];
        if (found.length > 0) {
            foundCount++;
            console.log(`\n[FOUND] ${url}`);
            found.forEach(f => {
                console.log(`    Position ${f.position} | Query: "${f.query}"`);
            });
        }
    });

    console.log('\n');
    console.log('='.repeat(60));
    console.log('NOT FOUND articles:');
    console.log('='.repeat(60));

    TARGET_URLS.forEach(url => {
        if (foundArticles[url].length === 0) {
            notFoundCount++;
            console.log(`  - ${url}`);
        }
    });

    console.log('\n');
    console.log('='.repeat(60));
    console.log(`SUMMARY: Found ${foundCount} / ${TARGET_URLS.length} articles`);
    console.log('='.repeat(60));

    // Save detailed results to file
    const report = {
        timestamp: new Date().toISOString(),
        searchDepth: 100,
        queriesCount: QUERIES.length,
        targetUrlsCount: TARGET_URLS.length,
        foundCount: foundCount,
        notFoundCount: notFoundCount,
        foundArticles: foundArticles,
        allResults: allResults
    };

    fs.writeFileSync('../data/50-statey.json', JSON.stringify(report, null, 2));
    console.log('\nDetailed results saved to: data/50-statey.json');

    // Also save as current bulk-search-results for web interface
    fs.writeFileSync('../data/bulk-search-results.json', JSON.stringify(report, null, 2));
}

main().catch(console.error);
