const fs = require('fs');
const data = JSON.parse(fs.readFileSync('../data/projects.json', 'utf8'));
const project = data.find(p => p.name === 'КЕ');
const entitiesWithoutParsings = project.entities.filter(e => !e.parsings || e.parsings.length === 0);
console.log('Сущности без парсингов:');
entitiesWithoutParsings.forEach(e => {
    console.log(project.id + '|' + e.id + '|' + e.name);
});
console.log('---');
console.log('Всего: ' + entitiesWithoutParsings.length);
