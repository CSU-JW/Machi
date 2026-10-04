const labels={green:'自己收益',blue:'全场收益',red:'收取金币',purple:'每人唯一'};
function tile(card, interactive=true){
  const el=document.createElement(interactive?'button':'div');el.className=`card ${card.color}`;
  const img=document.createElement('img');img.src=`assets/cards/${card.id}.png`;img.alt=`${card.name}卡通建筑`;img.loading='lazy';el.append(img);
  for(const [cls,text] of [['points',`🎲 ${card.points.join('～')}`],['name',card.name],['cost',`🪙 ${card.cost}`],['kind',labels[card.color]]]){const span=document.createElement('span');span.className=cls;span.textContent=text;el.append(span);}
  if(interactive){el.type='button';el.setAttribute('aria-label',`查看${card.name}详情`);el.onclick=()=>{document.getElementById('detailCard').replaceChildren(tile(card,false));document.getElementById('title').textContent=card.name;document.getElementById('description').textContent=card.description;document.getElementById('stock').textContent=`公共牌堆 ${card.limit} 张 · ${labels[card.color]} · 无商业中心加成`;document.getElementById('detail').showModal();};}return el;
}
function render(color='all'){document.getElementById('cards').replaceChildren(...DLC1.buildings.filter(c=>color==='all'||c.color===color).map(c=>tile(c)));document.querySelectorAll('[data-color]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.color===color)));}
document.querySelectorAll('[data-color]').forEach(b=>b.onclick=()=>render(b.dataset.color));
function note(container,title,lines){const article=document.createElement('article');article.className='note';const h=document.createElement('h3');h.textContent=title;article.append(h);for(const line of lines){const p=document.createElement('p');p.textContent=line;article.append(p);}document.getElementById(container).append(article);}
DLC1.tasks.forEach(t=>note('tasks',`${t.name} · ${t.tier}`,[t.condition,`奖励：${t.reward}`,`设计依据：${t.reason}`]));
DLC1.events.forEach(e=>note('events',e.name,[e.effect]));
DLC1.roles.forEach(r=>note('roles',`${r.name} · ${r.type}`,[r.effect,`整局收益上限：${r.cap}`]));render();
