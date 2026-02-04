const fs = require('fs');
const data = JSON.parse(fs.readFileSync('../data/projects.json', 'utf8'));
const project = data.find(p => p.name === 'КЕ');

console.log('Всего запросов:', project.entities.length);
const withParsings = project.entities.filter(e => e.parsings && e.parsings.length > 0);
const withoutParsings = project.entities.filter(e => !e.parsings || e.parsings.length === 0);
console.log('С парсингами:', withParsings.length);
console.log('Без парсингов:', withoutParsings.length);

console.log('\nЗапросы без парсингов:');
withoutParsings.forEach((e, i) => console.log((i+1) + '. ' + e.name));
