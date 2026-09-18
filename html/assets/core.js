/* Shared demo engine for the Aurora family.
   Right panel renders whatever BLOCKS come back: hero | stats | list | bars | table | note | text
   Orb variants listen for the `jarvis:state` event on document (detail = state string). */
const QUERIES = [
{chip:"How many cleaners?",q:"How many cleaners do I have?",
 say:"You have 24 cleaners on the roster today — 15 are on jobs and 9 are free.",
 blocks:[
  {type:"hero",value:24,label:"cleaners on the roster",sub:"3 more than this time last week"},
  {type:"stats",items:[{label:"Busy",value:15,sub:"on active jobs",tone:"warn"},
                       {label:"Free",value:9,sub:"ready to assign",tone:"ok"},
                       {label:"Off today",value:2,sub:"annual leave",tone:""}]},
  {type:"list",title:"Team snapshot",items:[
    {name:"Maria S.",meta:"Al Barsha · villa deep clean",status:"Busy",tone:"busy"},
    {name:"Joseph K.",meta:"Marina · since 09:40",status:"Busy",tone:"busy"},
    {name:"Anita R.",meta:"JLT · available now",status:"Free",tone:"free"},
    {name:"Daniel M.",meta:"Deira · available now",status:"Free",tone:"free"},
    {name:"Grace O.",meta:"Business Bay · running late",status:"Late",tone:"late"}]}]},

{chip:"Who's free now?",q:"Who is free right now?",
 say:"9 cleaners are free. The closest three to your Business Bay job are Anita, Daniel and Peter.",
 blocks:[
  {type:"stats",items:[{label:"Free now",value:9,sub:"across 6 zones",tone:"ok"},
                       {label:"Under 15 min",value:3,sub:"from Business Bay",tone:""}]},
  {type:"list",title:"Available, nearest first",items:[
    {name:"Anita R.",meta:"JLT · 6 min away",status:"Free",tone:"free"},
    {name:"Daniel M.",meta:"Deira · 9 min away",status:"Free",tone:"free"},
    {name:"Peter A.",meta:"Al Quoz · 12 min away",status:"Free",tone:"free"},
    {name:"Sara N.",meta:"Mirdif · 21 min away",status:"Free",tone:"free"},
    {name:"Omar H.",meta:"Sharjah · 34 min away",status:"Free",tone:"free"}]}]},

{chip:"Today's jobs",q:"How are today's jobs going?",
 say:"38 jobs today. 26 done, 9 in progress, 3 running behind — Business Bay is the one to watch.",
 blocks:[
  {type:"stats",items:[{label:"Completed",value:26,sub:"of 38 jobs",tone:"ok"},
                       {label:"In progress",value:9,sub:"right now",tone:"warn"},
                       {label:"Delayed",value:3,sub:"needs attention",tone:"bad"}]},
  {type:"bars",title:"Jobs by area",items:[
    {label:"Marina",value:11,max:12},{label:"Business Bay",value:9,max:12},
    {label:"Al Barsha",value:7,max:12},{label:"JLT",value:6,max:12},{label:"Deira",value:5,max:12}]},
  {type:"list",title:"Needs your attention",items:[
    {name:"Business Bay · Apt 1204",meta:"Grace O. · 25 min behind",status:"Late",tone:"late"},
    {name:"Marina · Tower B",meta:"Joseph K. · 15 min behind",status:"Late",tone:"late"},
    {name:"Al Barsha · Villa 7",meta:"Unassigned · starts 14:00",status:"Open",tone:"info"}]}]},

{chip:"Revenue this month",q:"What's my revenue this month?",
 say:"You've billed AED 184,500 so far in September — 12% ahead of August at the same point.",
 blocks:[
  {type:"hero",prefix:"AED ",value:184500,label:"billed in September",sub:"+12% vs August · 4 days left"},
  {type:"bars",title:"Weekly billing",items:[
    {label:"Week 1",value:52000,max:60000},{label:"Week 2",value:48500,max:60000},
    {label:"Week 3",value:31000,max:60000},{label:"Week 4",value:53000,max:60000}]},
  {type:"text",value:"Week 3 dipped because six villa contracts were rescheduled to the last week of the month. Collections are on track — AED 22,400 is still outstanding across 9 invoices."}]},

{chip:"Compare two cleaners",q:"Compare Maria and Joseph this week",
 say:"Maria is ahead on every measure this week. Joseph's on-time rate is the one to look at.",
 blocks:[
  {type:"table",title:"This week",cols:["Metric","Maria S.","Joseph K."],rows:[
    ["Jobs completed","18","14"],["On-time rate","96%","82%"],["Average rating","4.9","4.4"],
    ["Hours logged","41h","37h"],["Repeat requests","7","2"]]},
  {type:"note",tone:"warn",title:"Worth a conversation",
   text:"Joseph has been late on 4 of his last 12 jobs, all of them in Marina traffic. Consider giving him earlier slots."}]},

{chip:"Anyone in Sharjah tomorrow?",q:"Do I have anyone in Sharjah tomorrow?",
 say:"Yes — Omar has two jobs in Sharjah tomorrow, both in the morning.",
 blocks:[
  {type:"note",tone:"ok",title:"Yes, Omar H. is covering Sharjah",text:"Two jobs booked, 08:00 and 11:30. He's free from 13:00 onward."},
  {type:"list",title:"Sharjah · tomorrow",items:[
    {name:"Al Nahda · Apt 803",meta:"08:00 – 10:30",status:"Booked",tone:"info"},
    {name:"Al Majaz · Office 2B",meta:"11:30 – 13:00",status:"Booked",tone:"info"}]}]},

{chip:"Something I can't answer",q:"What's the weather in Tokyo tomorrow?",
 say:"I can't answer that one — I'm only connected to your operations data.",
 blocks:[
  {type:"note",tone:"bad",title:"No data source for that",
   text:"Weather isn't connected. I can answer anything about cleaners, jobs, schedules, customers and billing."}]}
];

const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const RENDER={
  hero:b=>'<div class="b-hero"><div class="hv">'+(b.prefix?'<span class="pfx">'+esc(b.prefix)+'</span>':'')+
    '<span class="num" data-to="'+b.value+'">0</span>'+(b.unit?'<span class="unit">'+esc(b.unit)+'</span>':'')+
    '</div><div class="hl">'+esc(b.label)+'</div>'+(b.sub?'<div class="hs">'+esc(b.sub)+'</div>':'')+'</div>',
  stats:b=>(b.title?'<div class="b-title">'+esc(b.title)+'</div>':'')+'<div class="b-stats">'+
    b.items.map(s=>'<div class="tile '+(s.tone||'')+'"><h3>'+esc(s.label)+'</h3>'+
      '<span class="num" data-to="'+s.value+'">0</span><div class="s">'+esc(s.sub||'')+'</div></div>').join('')+'</div>',
  list:b=>(b.title?'<div class="b-title">'+esc(b.title)+'</div>':'')+
    b.items.map(r=>'<div class="row"><div class="av">'+esc(r.name[0])+'</div><div class="nm">'+esc(r.name)+'</div>'+
      '<div class="mt">'+esc(r.meta)+'</div><div class="pill '+(r.tone||'info')+'">'+esc(r.status)+'</div></div>').join(''),
  bars:b=>(b.title?'<div class="b-title">'+esc(b.title)+'</div>':'')+
    b.items.map(i=>'<div class="bar"><div>'+esc(i.label)+'</div><div class="track">'+
      '<span class="fill" data-w="'+Math.round(i.value/i.max*100)+'"></span></div>'+
      '<div class="v">'+i.value.toLocaleString()+'</div></div>').join(''),
  table:b=>(b.title?'<div class="b-title">'+esc(b.title)+'</div>':'')+
    '<table class="b-table"><thead><tr>'+b.cols.map(c=>'<th>'+esc(c)+'</th>').join('')+'</tr></thead><tbody>'+
    b.rows.map(r=>'<tr>'+r.map(c=>'<td>'+esc(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table>',
  note:b=>'<div class="b-note '+(b.tone||'')+'">'+(b.title?'<b>'+esc(b.title)+'</b>':'')+'<span>'+esc(b.text)+'</span></div>',
  text:b=>'<p class="b-text">'+esc(b.value)+'</p>'
};
const $=s=>document.querySelector(s),body=document.body;
const LBL={idle:["Ready","Ask me anything"],listening:["Listening…","I'm picking that up"],
           thinking:["One moment","Looking that up"],speaking:["Here you go","Reading the result"]};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const setState=s=>{body.dataset.state=s;$('#stateLabel').textContent=LBL[s][0];$('#stateSub').textContent=LBL[s][1];
  document.dispatchEvent(new CustomEvent('jarvis:state',{detail:s}))};
const tick=()=>$('#clock').textContent=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
tick();setInterval(tick,1000);
QUERIES.forEach((q,i)=>{const b=document.createElement('button');b.textContent=q.chip;b.onclick=()=>run(i);$('#chips').appendChild(b)});
function countTo(el){const n=+el.dataset.to;let c=0;const s=Math.max(1,Math.round(n/24));
  const T=setInterval(()=>{c+=s;if(c>=n){c=n;clearInterval(T)}el.textContent=c.toLocaleString()},26)}
function paint(blocks){
  const host=$('#blocks');host.innerHTML='';host.scrollTop=0;
  blocks.forEach((b,i)=>{
    const el=document.createElement('div');el.className='blk';
    el.innerHTML=(RENDER[b.type]||RENDER.text)(b);host.appendChild(el);
    setTimeout(()=>{el.classList.add('show');
      el.querySelectorAll('[data-to]').forEach(countTo);
      el.querySelectorAll('[data-w]').forEach((f,k)=>setTimeout(()=>f.style.width=f.dataset.w+'%',k*70));
    },140+i*160);
  });
}
let busy=false;
async function run(i){
  if(busy)return;busy=true;const d=QUERIES[i];
  $('#say').className='say';$('#say').textContent='';$('#blocks').innerHTML='';
  setState('listening');$('#qt').textContent='';
  for(const ch of d.q){$('#qt').textContent+=ch;await wait(34)}
  await wait(450);setState('thinking');await wait(900);setState('speaking');
  $('#say').textContent=d.say;requestAnimationFrame(()=>$('#say').classList.add('show'));
  paint(d.blocks);
  await wait(6500);setState('idle');busy=false;
}
setTimeout(()=>run(0),700);

/* ---- version switcher -------------------------------------------------
   Back to the index, plus step straight to the next concept without going
   through it. Suppressed inside the index's preview iframes. */
const VERSIONS=[
 {f:'v6-lattice.html',  n:'V6', t:'Neural Lattice'},
 {f:'v7-gyro.html',     n:'V7', t:'Gyro Halo'},
 {f:'v8-resonance.html',n:'V8', t:'Resonance'},
 {f:'v9-flux.html',     n:'V9', t:'Flux'},
 {f:'v10-prism.html',   n:'V10',t:'Prism Bloom'},
 {f:'v11-hud.html',     n:'V11',t:'HUD Array'},
 {f:'v12-ember.html',   n:'V12',t:'Ember Flux'},
 {f:'v13-glyph.html',   n:'V13',t:'Glyph Core'},
 {f:'v14-spectrum.html',n:'V14',t:'Spectrum Bloom'},
 {f:'v15-tesseract.html',n:'V15',t:'Tesseract'},
 {f:'v16-ferro.html',   n:'V16',t:'Ferrofluid'},
 {f:'v17-aperture.html',n:'V17',t:'Aperture'},
 {f:'v18-wormhole.html',n:'V18',t:'Wormhole'}
];
if(window.self===window.top){
  const here=decodeURIComponent((location.pathname.split('/').pop()||''));
  const i=VERSIONS.findIndex(v=>v.f===here);
  const nav=document.createElement('div');nav.className='nav';
  const link=(cls,href,txt,title)=>{const a=document.createElement('a');
    a.className=cls;a.href=href;a.textContent=txt;if(title)a.title=title;return a};
  nav.appendChild(link('home','index.html','← All concepts','Back to the index'));
  if(i>=0){
    const prev=VERSIONS[(i-1+VERSIONS.length)%VERSIONS.length],next=VERSIONS[(i+1)%VERSIONS.length];
    nav.appendChild(link('step',prev.f,'‹','Previous · '+prev.t));
    const cur=document.createElement('span');cur.className='cur';
    cur.textContent=VERSIONS[i].n+' · '+VERSIONS[i].t;nav.appendChild(cur);
    nav.appendChild(link('step',next.f,'›','Next · '+next.t));
    const k=document.createElement('span');k.className='kbd';k.textContent='← →';nav.appendChild(k);
    addEventListener('keydown',e=>{
      if(e.metaKey||e.ctrlKey||e.altKey||/^(INPUT|TEXTAREA)$/.test(e.target.tagName))return;
      if(e.key==='ArrowLeft'){e.preventDefault();location.href=prev.f}
      else if(e.key==='ArrowRight'){e.preventDefault();location.href=next.f}
      else if(e.key==='Escape'){e.preventDefault();location.href='index.html'}});
  }
  document.body.appendChild(nav);
}
