// server.js - JAVI SMM Pro v3.3 FULL SUPABASE - PARCHEADO OFFLINE
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const MASTER_KEY = 'Romi';

app.use(cors());
app.use(express.json());

function authMaster(req, res, next) {
  if (req.headers['x-master-key'] === MASTER_KEY) return next();
  return res.status(401).json({ error: 'No autorizado' });
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let db = {
  users: [],
  resellers: [],
  reseller_moves: [],
  providers: [],
  services: [],
  orders: [],
  settings: { whatsapp: '595983399906', margin: 30, usd_gs: 7500, announce: '' }
};

let dbLoaded = false;

async function loadDB() {
  try {
    const { data: row } = await supabase.from('app_store').select('*').eq('key', 'main_db').single();
    if (row && row.data) {
      db = {...db,...row.data };
      dbLoaded = true;
      console.log('✅ DB cargada desde Supabase');
    }
    else {
      await supabase.from('app_store').upsert({ key: 'main_db', data: db });
      dbLoaded = true;
      console.log('📦 DB inicializada');
    }
  } catch (e) {
    console.error('⚠ Error Supabase (offline, no se cargó):', e.message);
    dbLoaded = false;
  }
}
async function saveDB() {
  if (!dbLoaded) {
    console.log('⏸️ saveDB omitido: DB no cargada (offline)');
    return;
  }
  try { await supabase.from('app_store').upsert({ key: 'main_db', data: db }); }
  catch (e) { console.error('❌ Error guardar:', e.message); }
}

app.get('/api/health', (req, res) => res.json({ ok: true, version: 'v3.3-supabase-parcheado' }));
app.get('/api/public-settings', (req,res)=>res.json({whatsapp:db.settings.whatsapp, announce:db.settings.announce||''}));
app.get('/api/settings', authMaster, (req,res)=>res.json(db.settings));
app.post('/api/settings', authMaster, (req,res)=>{ db.settings={...db.settings,...req.body}; saveDB(); res.json({ok:true}); });

app.get('/api/providers', authMaster, async (req,res)=>{
  for(let p of db.providers){
    if(p.active && p.api_url && p.api_key){
      try{
        const form=new URLSearchParams({key:p.api_key,action:'balance'});
        const rb=await fetch(p.api_url,{method:'POST',body:form,headers:{'Content-Type':'application/x-www-form-urlencoded'}});
        const jb=await rb.json();
        p.balance = jb.balance!==undefined?jb.balance:(jb.usd!==undefined?jb.usd:p.balance);
      }catch(e){}
    }
  }
  saveDB(); res.json(db.providers);
});
app.post('/api/providers', authMaster, (req,res)=>{ db.providers.push({name:req.body.name,api_url:req.body.api_url,api_key:req.body.api_key,priority:req.body.priority||99,active:true,balance:'--'}); saveDB(); res.json({ok:true}); });
app.post('/api/providers/:i/toggle', authMaster, (req,res)=>{ const p=db.providers[req.params.i]; if(p) p.active=!p.active; saveDB(); res.json({ok:true}); });
app.delete('/api/providers/:i', authMaster, (req,res)=>{ db.providers.splice(req.params.i,1); saveDB(); res.json({ok:true}); });

app.get('/api/services-all', authMaster, (req,res)=>res.json({data:db.services}));
app.post('/api/toggle-service', authMaster, (req,res)=>{ const s=db.services.find(x=>String(x.service)===String(req.body.service)); if(s) s.is_visible=!s.is_visible; saveDB(); res.json({ok:true}); });
app.post('/api/edit-service', authMaster, (req,res)=>{
  const s=db.services.find(x=>String(x.service)===String(req.body.service));
  if(!s) return res.status(404).json({error:'No encontrado'});
  const {name,price_gs,category,min,max,is_visible}=req.body;
  if(name!==undefined) s.name=name;
  if(price_gs!==undefined) s.price_gs=Number(price_gs);
  if(category!==undefined) s.category=category;
  if(min!==undefined) s.min=Number(min);
  if(max!==undefined) s.max=Number(max);
  if(is_visible!==undefined) s.is_visible=Boolean(is_visible);
  saveDB(); res.json({ok:true, service:s});
});

app.post('/api/sync-services', authMaster, async (req,res)=>{
  let total=0, offline=[];
  for(const p of db.providers.filter(x=>x.active)){
    try{
      const form=new URLSearchParams({key:p.api_key,action:'services'});
      const controller=new AbortController();
      const t=setTimeout(()=>controller.abort(),25000);
      const r=await fetch(p.api_url,{method:'POST',body:form,headers:{'Content-Type':'application/x-www-form-urlencoded'},signal:controller.signal});
      clearTimeout(t);
      if(!r.ok){ offline.push(p.name); continue; }
      const list=await r.json();
      if(!Array.isArray(list)||list.length===0){ offline.push(p.name); continue; }
      for(const s of list){
        const cost=parseFloat(s.rate||0);
        const price_usd=cost*(1+(db.settings.margin||30)/100);
        const price_gs=Math.ceil(price_usd*(db.settings.usd_gs||7500)/100)*100;
        const idx=db.services.findIndex(x=>String(x.service)===String(s.service)&&x.provider===p.name);
        if(idx>=0){
          db.services[idx].rate=cost;
          db.services[idx].min=s.min;
          db.services[idx].max=s.max;
          db.services[idx].type=s.type;
          db.services[idx].name=s.name;
          db.services[idx].category=s.category;
        }else{
          db.services.push({service:s.service,name:s.name,category:s.category||'General',rate:cost,price_usd:Number(price_usd.toFixed(4)),price_gs,min:s.min||10,max:s.max||10000,type:s.type,provider:p.name,is_visible:true});
        }
        total++;
      }
    }catch(e){ offline.push(p.name); }
  }
  saveDB();
  if(total===0) return res.json({ok:false, warning:'Proveedor offline. Catálogo local intacto.', offline});
  res.json({ok:true, count:total, offline});
});

app.get('/api/users', authMaster, (req,res)=>res.json(db.users));
app.post('/api/add-balance', authMaster, (req,res)=>{
  const username=String(req.body.username||'').toLowerCase().trim();
  const amount=Number(req.body.amount);
  let u=db.users.find(x=>x.username===username);
  if(!u){ u={username,balance:0}; db.users.push(u); }
  u.balance=Number(u.balance||0)+amount; if(u.balance<0)u.balance=0;
  saveDB(); res.json({ok:true,balance:u.balance});
});

app.post('/api/reseller-login',(req,res)=>{
  const r=db.resellers.find(x=>x.user===String(req.body.user||'').toLowerCase());
  if(!r||r.pass!==req.body.pass) return res.json({error:'Usuario o contraseña incorrectos'});
  if(r.active===false) return res.json({error:'Cuenta pausada'});
  res.json({user:r.user,balance:r.balance});
});
app.get('/api/reseller-moves/:user',(req,res)=>res.json(db.reseller_moves.filter(m=>m.reseller===req.params.user.toLowerCase()).slice(0,200)));
app.post('/api/reseller-load',(req,res)=>{
  const r=db.resellers.find(x=>x.user===String(req.body.reseller_user||'').toLowerCase());
  if(!r||r.pass!==req.body.reseller_pass) return res.json({error:'No autorizado'});
  const amt=Number(req.body.amount);
  if(amt<1000) return res.json({error:'Mínimo ₲1.000'});
  if(Number(r.balance)<amt) return res.json({error:'Saldo insuficiente'});
  r.balance-=amt;
  const cname=String(req.body.client_username||'').toLowerCase().trim();
  let c=db.users.find(x=>x.username===cname);
  if(!c){ c={username:cname,balance:0}; db.users.push(c); }
  c.balance+=amt;
  db.reseller_moves.unshift({reseller:r.user,client:c.username,amount:amt,date:new Date().toISOString()});
  saveDB(); res.json({ok:true,new_balance:r.balance});
});
app.post('/api/reseller-change-pass',(req,res)=>{
  const r=db.resellers.find(x=>x.user===String(req.body.user||'').toLowerCase());
  if(!r||r.pass!==req.body.pass) return res.json({error:'No autorizado'});
  r.pass=req.body.newPass; saveDB(); res.json({ok:true});
});
app.get('/api/admin/resellers', authMaster, (req,res)=>res.json(db.resellers));
app.post('/api/admin/reseller-create', authMaster, (req,res)=>{
  const user=String(req.body.user||'').toLowerCase().trim();
  if(db.resellers.find(x=>x.user===user)) return res.status(400).json({error:'Ya existe'});
  db.resellers.push({user,pass:req.body.pass,balance:Number(req.body.balance||0),note:req.body.note||'',active:true});
  saveDB(); res.json({ok:true});
});
app.post('/api/admin/reseller-add', authMaster, (req,res)=>{
  const r=db.resellers.find(x=>x.user===String(req.body.user||'').toLowerCase());
  if(!r) return res.status(404).json({error:'No encontrado'});
  r.balance=Number(r.balance||0)+Number(req.body.amount); if(r.balance<0)r.balance=0;
  saveDB(); res.json({ok:true,balance:r.balance});
});
app.post('/api/admin/reseller-pass', authMaster, (req,res)=>{ const r=db.resellers.find(x=>x.user===String(req.body.user||'').toLowerCase()); if(r){r.pass=req.body.newPass;saveDB();} res.json({ok:true}); });
app.post('/api/admin/reseller-note', authMaster, (req,res)=>{ const r=db.resellers.find(x=>x.user===String(req.body.user||'').toLowerCase()); if(r){r.note=req.body.note;saveDB();} res.json({ok:true}); });
app.post('/api/admin/reseller-toggle', authMaster, (req,res)=>{ const r=db.resellers.find(x=>x.user===String(req.body.user||'').toLowerCase()); if(r){r.active=r.active===false?true:false;saveDB();} res.json({ok:true}); });
app.post('/api/admin/reseller-delete', authMaster, (req,res)=>{ db.resellers=db.resellers.filter(x=>x.user!==String(req.body.user||'').toLowerCase()); saveDB(); res.json({ok:true}); });
app.get('/api/orders', authMaster, (req,res)=>res.json(db.orders));

app.get('/api/services',(req,res)=>res.json({data:db.services.filter(s=>s.is_visible!==false)}));

function handleMe(req,res){
  const username=String(req.body.username||'').toLowerCase().trim();
  if(!username) return res.json({error:'Usuario requerido'});
  let u=db.users.find(x=>x.username===username);
  if(!u){ u={username,balance:0}; db.users.push(u); saveDB(); }
  res.json({username:u.username,balance:u.balance});
}
app.post('/api/me', handleMe);
app.post('/api/client-login', handleMe);

async function handleOrder(req,res){
  const {username,service,link,quantity}=req.body;
  const s=db.services.find(x=>String(x.service)===String(service));
  if(!s) return res.json({error:'Servicio no encontrado'});
  const qty=Number(quantity);
  const price=Math.ceil((s.price_gs/1000)*qty);
  let u=db.users.find(x=>x.username===String(username||'').toLowerCase());
  if(!u) return res.json({error:'Usuario no encontrado'});
  if((u.balance||0)<price) return res.json({error:'Saldo insuficiente'});
  u.balance-=price;
  const order={id:Date.now(),username:u.username,service:s.name,link,quantity:qty,total_gs:price,status:'pending',date:new Date().toISOString(),provider:s.provider,provider_service:s.service};
  try{
    const p=db.providers.find(x=>x.name===s.provider&&x.active);
    if(p){
      const form=new URLSearchParams({key:p.api_key,action:'add',service:s.service,link,quantity:String(qty)});
      await fetch(p.api_url,{method:'POST',body:form,headers:{'Content-Type':'application/x-www-form-urlencoded'}});
    }
  }catch(e){}
  db.orders.unshift(order); saveDB();
  res.json({ok:true,order_id:order.id,order:{id:order.id,total_gs:price},new_balance:u.balance});
}
app.post('/api/order', handleOrder);
app.post('/api/create-order', handleOrder);

loadDB().then(()=>{ app.listen(PORT,()=>console.log('JAVI v3.3 Pro activo en '+PORT)); });