const API = "/api";
let currentUser = null;
let authMode = "login";
let appStarted = false;
const $ = (id) => document.getElementById(id);
const money = (value) => Number(value || 0).toLocaleString("pt-BR",{style:"currency",currency:"BRL"});
const dateBR = (value) => value ? new Date(value+"T12:00:00").toLocaleDateString("pt-BR") : "—";
let categories = [];

async function request(url, options={}) {
  const response = await fetch(API+url, { headers:{"Content-Type":"application/json"}, ...options });
  const data = await response.json().catch(()=>({}));
  if (response.status === 401) { await showAuth(); }
  if (!response.ok) throw new Error(data.error || "Não foi possível concluir a operação.");
  return data;
}
function toast(message) { const el=$("toast"); el.textContent=message; el.classList.add("show"); setTimeout(()=>el.classList.remove("show"),2600); }
function showModal(id){$(id).classList.add("open")}
function closeModal(id){$(id).classList.remove("open")}
function today(){return new Date().toISOString().slice(0,10)}
function monthNow(){return today().slice(0,7)}
function escapeHtml(value){return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}

async function loadCategories(){categories=await request("/categories");}
function switchPage(page){
  document.querySelectorAll(".page").forEach(p=>p.classList.remove("active"));
  $(page+"-page").classList.add("active");
  document.querySelectorAll(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
  const titles={dashboard:"Visão geral",receitas:"Receitas",despesas:"Despesas",relatorios:"Relatórios",categorias:"Categorias"};
  $("page-title").textContent=titles[page];
  if(page==="dashboard") loadDashboard();
  if(page==="receitas") loadTransactions("receita");
  if(page==="despesas") loadTransactions("despesa");
  if(page==="relatorios") loadReport();
  if(page==="categorias") renderCategories();
}
document.querySelectorAll(".nav-item").forEach(b=>b.addEventListener("click",()=>switchPage(b.dataset.page)));
document.querySelectorAll("[data-goto]").forEach(b=>b.addEventListener("click",()=>switchPage(b.dataset.goto)));
document.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",()=>closeModal(b.dataset.close)));
document.querySelectorAll(".modal-backdrop").forEach(el=>el.addEventListener("click",e=>{if(e.target===el)closeModal(el.id)}));

async function loadDashboard(){
  try{
    const data=await request("/dashboard?month="+$("dashboard-month").value);
    $("total-receitas").textContent=money(data.receitas);
    $("total-despesas").textContent=money(data.despesas);
    $("total-saldo").textContent=money(data.saldo);
    $("total-saldo").style.color=data.saldo<0?"#c47c70":"#6b5680";
    $("total-movimentos").textContent=data.quantidade;
    renderChart(data.byDay);
    const cats=data.byCategory;
    $("category-summary").innerHTML=cats.length?cats.slice(0,6).map(c=>`<div class="category-row"><span class="name">${escapeHtml(c.name)}</span><span class="amount">${money(c.total)}</span><div class="progress"><span style="width:${Math.min(100,c.total/Math.max(...cats.map(x=>x.total))*100)}%;background:${c.color}"></span></div></div>`).join(""):'<div class="empty-state">Ainda não há movimentações neste período.</div>';
    $("recent-table").innerHTML=data.latest.length?data.latest.map(row=>`<tr><td>${escapeHtml(row.description)}</td><td>${escapeHtml(row.category_name)}</td><td>${dateBR(row.date)}</td><td><span class="type-pill ${row.type}">${row.type==="receita"?"Receita":"Despesa"}</span></td><td class="right ${row.type==="receita"?"amount-income":"amount-expense"}">${row.type==="receita"?"+":"−"} ${money(row.amount)}</td></tr>`).join(""):'<tr><td colspan="5" class="empty-state">Nenhuma movimentação cadastrada.</td></tr>';
  }catch(e){toast(e.message)}
}
function renderChart(rows){
  if(!rows.length){$("chart").innerHTML='<div class="chart-empty">Sem dados para exibir neste mês.</div>';return}
  const max=Math.max(1,...rows.flatMap(r=>[r.receitas,r.despesas]));
  $("chart").innerHTML=rows.map(r=>`<div class="bar-group"><div class="bar income" title="Receitas: ${money(r.receitas)}" style="height:${Math.max(2,r.receitas/max*100)}%"></div><div class="bar expense" title="Despesas: ${money(r.despesas)}" style="height:${Math.max(2,r.despesas/max*100)}%"></div><span class="bar-label">${Number(r.date.slice(-2))}</span></div>`).join("");
}

async function loadTransactions(type){
  const prefix=type==="receita"?"income":"expense";
  const params=new URLSearchParams({type});
  const search=$(prefix+"-search").value,from=$(prefix+"-from").value,to=$(prefix+"-to").value;
  if(search)params.set("search",search);if(from)params.set("from",from);if(to)params.set("to",to);
  const rows=await request("/transactions?"+params.toString());
  const tbody=$(prefix+"-table");
  tbody.innerHTML=rows.length?rows.map(r=>`<tr><td>${escapeHtml(r.description)}</td>${type==="receita"?`<td>${escapeHtml(r.client_name||"—")}</td>`:""}<td>${escapeHtml(r.category_name)}</td><td>${dateBR(r.date)}</td><td>${escapeHtml(r.payment_method)}</td><td class="right ${type==="receita"?"amount-income":"amount-expense"}">${money(r.amount)}</td><td><button class="action-btn" title="Editar" data-edit="${r.id}" data-type="${type}">✎</button><button class="action-btn delete" title="Excluir" data-delete="${r.id}">⌫</button></td></tr>`).join(''):`<tr><td colspan="${type==="receita"?7:6}" class="empty-state">Nenhuma movimentação encontrada.</td></tr>`;
  tbody.querySelectorAll("[data-edit]").forEach(b=>b.addEventListener("click",()=>editTransaction(Number(b.dataset.edit),b.dataset.type)));
  tbody.querySelectorAll("[data-delete]").forEach(b=>b.addEventListener("click",()=>deleteTransaction(Number(b.dataset.delete),type)));
}
["income","expense"].forEach(prefix=>{
  ["search","from","to"].forEach(s=>$(prefix+"-"+s).addEventListener("input",()=>loadTransactions(prefix==="income"?"receita":"despesa")));
  $(prefix+"-clear").addEventListener("click",()=>{["search","from","to"].forEach(s=>$(prefix+"-"+s).value="");loadTransactions(prefix==="income"?"receita":"despesa")});
});
$("dashboard-month").addEventListener("change",loadDashboard);

function openTransaction(type,row=null){
  $("transaction-form").reset();
  $("transaction-id").value=row?.id||"";
  $("transaction-type").value=type;
  $("transaction-modal-title").textContent=(row?"Editar ":"Nova ")+(type==="receita"?"receita":"despesa");
  const clientField=$("client-name-field");
  clientField.hidden=type!=="receita";
  $("transaction-client-name").required=type==="receita";
  const options=categories.filter(c=>c.type===type);
  $("transaction-category").innerHTML=options.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  if(row){
    $("transaction-description").value=row.description;$("transaction-client-name").value=row.client_name||"";$("transaction-amount").value=row.amount;$("transaction-date").value=row.date;
    $("transaction-category").value=row.category_id;$("transaction-payment").value=row.payment_method;$("transaction-notes").value=row.notes||"";
  }else{$("transaction-date").value=today()}
  $("transaction-error").textContent="";
  showModal("transaction-modal");
}
$("add-income").addEventListener("click",()=>openTransaction("receita"));
$("add-expense").addEventListener("click",()=>openTransaction("despesa"));
async function editTransaction(id,type){const rows=await request("/transactions?type="+type);const row=rows.find(x=>x.id===id);if(row)openTransaction(type,row)}
async function deleteTransaction(id,type){
  if(!confirm("Tem certeza de que deseja excluir esta movimentação?"))return;
  try{await request("/transactions/"+id,{method:"DELETE"});toast("Movimentação excluída.");loadTransactions(type);loadDashboard()}catch(e){toast(e.message)}
}
$("transaction-form").addEventListener("submit",async e=>{
  e.preventDefault();
  const id=$("transaction-id").value;
  const body={type:$("transaction-type").value,description:$("transaction-description").value,client_name:$("transaction-client-name").value.trim(),amount:Number($("transaction-amount").value),date:$("transaction-date").value,category_id:Number($("transaction-category").value),payment_method:$("transaction-payment").value,notes:$("transaction-notes").value};
  try{
    await request("/transactions"+(id?"/"+id:""),{method:id?"PUT":"POST",body:JSON.stringify(body)});
    closeModal("transaction-modal");toast(id?"Movimentação atualizada!":"Movimentação cadastrada!");
    loadTransactions(body.type);loadDashboard();if($("relatorios-page").classList.contains("active"))loadReport();
  }catch(err){$("transaction-error").textContent=err.message}
});

async function renderCategories(){
  await loadCategories();
  for(const [type,target] of [["receita","income-categories"],["despesa","expense-categories"]]){
    const list=categories.filter(c=>c.type===type);
    $(target).innerHTML=list.map(c=>`<div class="category-item"><div class="left"><i class="color-dot" style="background:${c.color}"></i>${escapeHtml(c.name)}</div><div class="actions"><button class="action-btn" data-category-edit="${c.id}">✎</button><button class="action-btn delete" data-category-delete="${c.id}">⌫</button></div></div>`).join("")||'<div class="empty-state">Nenhuma categoria cadastrada.</div>';
  }
  document.querySelectorAll("[data-category-edit]").forEach(b=>b.addEventListener("click",()=>editCategory(Number(b.dataset.categoryEdit))));
  document.querySelectorAll("[data-category-delete]").forEach(b=>b.addEventListener("click",()=>deleteCategory(Number(b.dataset.categoryDelete))));
}
$("add-category").addEventListener("click",()=>openCategory());
function openCategory(row=null){
  $("category-form").reset();$("category-id").value=row?.id||"";
  $("category-modal-title").textContent=row?"Editar categoria":"Nova categoria";
  if(row){$("category-name").value=row.name;$("category-type").value=row.type;$("category-color").value=row.color}
  $("category-error").textContent="";showModal("category-modal");
}
function editCategory(id){openCategory(categories.find(c=>c.id===id))}
$("category-form").addEventListener("submit",async e=>{
  e.preventDefault();const id=$("category-id").value;
  const body={name:$("category-name").value,type:$("category-type").value,color:$("category-color").value};
  try{await request("/categories"+(id?"/"+id:""),{method:id?"PUT":"POST",body:JSON.stringify(body)});closeModal("category-modal");toast("Categoria salva!");await renderCategories();await loadCategories()}
  catch(err){$("category-error").textContent=err.message}
});
async function deleteCategory(id){
  if(!confirm("Deseja excluir esta categoria?"))return;
  try{await request("/categories/"+id,{method:"DELETE"});toast("Categoria excluída.");renderCategories()}
  catch(e){toast(e.message)}
}

async function loadReport(){
  const params=new URLSearchParams();if($("report-from").value)params.set("from",$("report-from").value);if($("report-to").value)params.set("to",$("report-to").value);
  const data=await request("/reports?"+params.toString());
  $("report-income").textContent=money(data.receitas);$("report-expense").textContent=money(data.despesas);$("report-balance").textContent=money(data.saldo);$("report-count").textContent=data.quantidade;
  $("report-table").innerHTML=data.categories.filter(c=>c.total!==null).map(c=>`<tr><td>${escapeHtml(c.name)}</td><td><span class="type-pill ${c.type}">${c.type==="receita"?"Receita":"Despesa"}</span></td><td>${c.quantidade}</td><td class="right">${money(c.total)}</td></tr>`).join("")||'<tr><td colspan="4" class="empty-state">Nenhum registro no período.</td></tr>';
}
$("generate-report").addEventListener("click",loadReport);
$("print-report").addEventListener("click",()=>window.print());

async function startApp(user){
  currentUser=user;
  document.body.classList.remove("unauthenticated");
  $("sidebar-user-name").textContent=user.name;
  $("sidebar-avatar").textContent=(user.name.trim()[0]||"U").toUpperCase();
  $("top-avatar").textContent=(user.name.trim()[0]||"U").toUpperCase();
  $("welcome-name").textContent=user.name.split(/\s+/)[0];
  if(appStarted) return;
  appStarted=true;
  $("today-label").textContent=new Date().toLocaleDateString("pt-BR",{day:"2-digit",month:"long",year:"numeric"});
  $("dashboard-month").value=monthNow();
  $("report-from").value=monthNow()+"-01";$("report-to").value=today();
  try{await loadCategories();await loadDashboard();}catch(e){toast("Erro ao conectar ao servidor: "+e.message)}
}
function setAuthMode(mode){
  authMode=mode;
  const creating=mode==="register";
  $("auth-title").textContent=creating?"Crie sua conta":"Acesse sua conta";
  $("auth-subtitle").textContent=creating?"Cadastre a conta que será usada para acessar a gestão financeira do estabelecimento.":"Entre para acompanhar as receitas e despesas do seu espaço.";
  $("auth-name-wrap").classList.toggle("hidden",!creating);
  $("auth-name").required=creating;
  $("auth-password").autocomplete=creating?"new-password":"current-password";
  $("auth-submit").textContent=creating?"Criar conta e entrar":"Entrar";
  $("auth-mode-toggle").textContent=creating?"Já tem uma conta? Entrar":"Criar uma conta";
  $("auth-error").textContent="";
}
async function showAuth(){
  document.body.classList.add("unauthenticated");
  try{
    const response=await fetch(API+"/auth/status");
    const status=await response.json();
    const mode=status.accountConfigured?"login":"register";
    setAuthMode(mode);
    $("auth-mode-toggle").classList.toggle("hidden",!status.accountConfigured);
    $("auth-mode-note").textContent=status.accountConfigured?"Entre com sua conta ou cadastre um novo usuário.":"Primeiro acesso: crie uma conta para começar.";
  }catch(_){setAuthMode("login");$("auth-error").textContent="Não foi possível conectar ao servidor. Verifique se ele está iniciado."}
}
$("auth-mode-toggle").addEventListener("click",()=>setAuthMode("register"));
$("auth-form").addEventListener("submit",async e=>{
  e.preventDefault();
  const body={email:$("auth-email").value.trim(),password:$("auth-password").value};
  if(authMode==="register")body.name=$("auth-name").value.trim();
  $("auth-submit").disabled=true;$("auth-submit").textContent="Aguarde...";$("auth-error").textContent="";
  try{
    const response=await fetch(API+"/auth/"+(authMode==="register"?"register":"login"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||"Não foi possível entrar.");
    $("auth-form").reset();await startApp(data.user);toast(authMode==="register"?"Conta criada com sucesso!":"Login realizado com sucesso!");
  }catch(err){$("auth-error").textContent=err.message}
  finally{$("auth-submit").disabled=false;$("auth-submit").textContent=authMode==="register"?"Criar conta e entrar":"Entrar"}
});
$("logout-button").addEventListener("click",async()=>{
  try{await fetch(API+"/auth/logout",{method:"POST"})}catch(_){}
  currentUser=null;appStarted=false;await showAuth();toast("Você saiu da sua conta.");
});
async function init(){
  try{
    const response=await fetch(API+"/auth/me");
    if(response.ok){const data=await response.json();await startApp(data.user);}
    else await showAuth();
  }catch(_){await showAuth();$("auth-error").textContent="Não foi possível conectar ao servidor. Inicie a aplicação e atualize esta página."}
}
init();
