const students = [
  {id:'demo-1',name:'Студент 01',group:'ДЕМО-201',rate:92,gap:0,debt:false},
  {id:'demo-2',name:'Студент 02',group:'ДЕМО-201',rate:64,gap:7,debt:true},
  {id:'demo-3',name:'Студент 03',group:'ДЕМО-201',rate:85,gap:0,debt:false},
  {id:'demo-4',name:'Студент 04',group:'ДЕМО-201',rate:71,gap:3,debt:true},
  {id:'demo-5',name:'Студент 05',group:'ДЕМО-201',rate:50,gap:8,debt:false},
];
let marks={};try{marks=JSON.parse(localStorage.getItem('attendance-public-demo')||'{}')}catch{}
let view='journal',filter='all';
const content=document.querySelector('#content');
function render(){
 document.querySelector('#crumb').textContent=view==='journal'?'/ Посещаемость':'/ Руководство';
 document.querySelector('#journal-nav').classList.toggle('active',view==='journal');
 document.querySelector('#overview-nav').classList.toggle('active',view==='overview');
 if(view==='journal'){
 content.innerHTML=`<div class="page-heading"><div><div class="eyebrow">Кабинет преподавателя · демо</div><h1>Мой журнал</h1><p>Демонстрационный преподаватель</p></div></div><div class="date-strip"><div><strong>16 сентября · 10:00–11:20</strong><small>Пример занятия, не расписание РУЗ</small></div></div><div class="panel mirror-panel"><h2>Основы права</h2><p class="muted">Семинар · ДЕМО-201 · 5 вымышленных студентов</p><table class="mirror-table"><thead><tr><th>Студент</th><th>Отметка явки</th></tr></thead><tbody>${students.map(s=>`<tr><td class="mirror-name">${s.name}</td><td><button class="btn" data-id="${s.id}" data-status="present" aria-label="${s.name}: присутствовал" aria-pressed="${marks[s.id]==='present'}">Присутствовал</button><button class="btn" data-id="${s.id}" data-status="absent" aria-label="${s.name}: отсутствовал" aria-pressed="${marks[s.id]==='absent'}">Отсутствовал</button></td></tr>`).join('')}</tbody></table><div class="mirror-controls"><button class="btn" id="reset">Сбросить демоотметки</button><span class="muted" role="status">Отмечено: ${students.filter(s=>['present','absent'].includes(marks[s.id])).length} из 5</span></div></div>`;
 content.querySelectorAll('[data-status]').forEach(b=>b.onclick=()=>{if(marks[b.dataset.id]===b.dataset.status)delete marks[b.dataset.id];else marks[b.dataset.id]=b.dataset.status;save();render()});
 document.querySelector('#reset').onclick=()=>{marks={};save();render()};
 }else{
 const rows=students.filter(s=>filter==='all'||filter==='absent'&&s.gap>=7||filter==='debts'&&s.debt);
 content.innerHTML=`<div class="page-heading"><div><div class="eyebrow">Руководство · демо</div><h1>Иностранные студенты</h1><p>Вымышленный пример сводки. Показатели заданы для демонстрации и не связаны с демоотметками.</p></div></div><div class="metrics"><div class="metric"><label>Студентов</label><strong>5</strong><small>Учебный пример</small></div><div class="metric alert"><label>7 дней без явки</label><strong>2</strong><small>Учебных дней</small></div><div class="metric alert"><label>Просрочены процедуры</label><strong>2</strong><small>Вымышленные статусы</small></div><div class="metric"><label>Посещаемость</label><strong>72%</strong><small>Среднее по пяти студентам</small></div></div><div class="mirror-controls"><button class="btn" data-filter="all" aria-pressed="${filter==='all'}">Все студенты</button><button class="btn" data-filter="absent" aria-pressed="${filter==='absent'}">Не посещают</button><button class="btn" data-filter="debts" aria-pressed="${filter==='debts'}">Должники по процедурам</button></div><div class="panel mirror-panel"><table class="mirror-table"><thead><tr><th>Студент</th><th>Явка</th><th>Дней без явки</th><th>Процедуры</th></tr></thead><tbody>${rows.map(s=>`<tr><td>${s.name}<br><small>${s.group}</small></td><td>${s.rate}%</td><td>${s.gap}</td><td>${s.debt?'Есть просрочка':'Подтверждены'}</td></tr>`).join('')}</tbody></table></div>`;
 content.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;render()});
 }
}
function save(){try{localStorage.setItem('attendance-public-demo',JSON.stringify(marks))}catch{}}
document.querySelector('#journal-nav').onclick=()=>{view='journal';render()};
document.querySelector('#overview-nav').onclick=()=>{view='overview';render()};
render();
