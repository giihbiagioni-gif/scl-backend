// ============================================================
// Endpoint único de persistência do dashboard SCL, agora falando
// com o Supabase (Postgres + Storage) em vez do Redis/Upstash.
//
// GET    /api/storage?key=X   -> le o valor guardado sob a chave X
// POST   /api/storage?key=X   -> grava { value } sob a chave X
// DELETE /api/storage?key=X   -> apaga a chave X
//
// Regra especial: a chave "scl-dashboard-data-v1" (os números dos
// KPIs) não vai para a gaveta genérica — ela é lida/gravada direto
// nas tabelas scl_kpis_dim e scl_kpis_mensal. Tudo o mais (planos de
// ação, anomalias, DTOs, GAPA, justificativas, flags de "semente")
// cai na tabela genérica scl_app_kv.
//
// Fotos: se o valor salvo tiver um campo "img" em base64
// (data:image/...;base64,....), a foto é enviada para o bucket
// "fotos-planos" do Supabase Storage, e só o link público fica
// guardado no registro (em vez do textão gigante).
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DATA_KEY = 'scl-dashboard-data-v1';
const ANO = 2026;
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago"];
const PHOTO_BUCKET = 'fotos-planos';

function supaHeaders(extra = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    ...extra
  };
}

// ---------- tabela genérica (scl_app_kv) ----------

async function kvGet(key) {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/scl_app_kv?key=eq.${encodeURIComponent(key)}&select=value`,
    { headers: supaHeaders() }
  );
  if (!resp.ok) throw new Error(`kvGet falhou: ${resp.status} ${await resp.text()}`);
  const rows = await resp.json();
  return rows.length ? rows[0].value : null;
}

async function kvSet(key, value) {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/scl_app_kv?on_conflict=key`,
    {
      method: 'POST',
      headers: supaHeaders({
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      }),
      body: JSON.stringify([{ key, value, atualizado_em: new Date().toISOString() }])
    }
  );
  if (!resp.ok) throw new Error(`kvSet falhou: ${resp.status} ${await resp.text()}`);
}

async function kvDel(key) {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/scl_app_kv?key=eq.${encodeURIComponent(key)}`,
    { method: 'DELETE', headers: supaHeaders() }
  );
  if (!resp.ok) throw new Error(`kvDel falhou: ${resp.status} ${await resp.text()}`);
}

// ---------- tabelas de KPIs (scl_kpis_dim / scl_kpis_mensal) ----------

async function buildKpiDataValue() {
  const [dimResp, mensalResp] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/scl_kpis_dim?select=kpi_cod,gatilho_rs`, { headers: supaHeaders() }),
    fetch(`${SUPABASE_URL}/rest/v1/scl_kpis_mensal?select=kpi_cod,mes_idx,meta_rs,real_rs,fgli_meta_hl,fgli_real_hl,rs_por_hl_meta,rs_por_hl_real,wqi_meta,wqi_real&order=kpi_cod.asc,mes_idx.asc`, { headers: supaHeaders() })
  ]);
  if (!dimResp.ok) throw new Error(`Falha ao ler scl_kpis_dim: ${dimResp.status}`);
  if (!mensalResp.ok) throw new Error(`Falha ao ler scl_kpis_mensal: ${mensalResp.status}`);

  const dimRows = await dimResp.json();
  const mensalRows = await mensalResp.json();

  const porCod = {};
  for (const d of dimRows) {
    porCod[d.kpi_cod] = {
      cod: d.kpi_cod,
      gatilho: d.gatilho_rs,
      meta_mensal: Array(8).fill(null),
      real_mensal: Array(8).fill(null),
      fgli_meta_mensal: Array(8).fill(null),
      fgli_real_mensal: Array(8).fill(null),
      hl_meta_mensal: Array(8).fill(null),
      hl_real_mensal: Array(8).fill(null),
      wqi_meta_mensal: Array(8).fill(null),
      wqi_real_mensal: Array(8).fill(null)
    };
  }
  for (const m of mensalRows) {
    const k = porCod[m.kpi_cod];
    if (!k) continue;
    const i = m.mes_idx - 1;
    if (i < 0 || i > 7) continue;
    k.meta_mensal[i] = m.meta_rs;
    k.real_mensal[i] = m.real_rs;
    k.fgli_meta_mensal[i] = m.fgli_meta_hl;
    k.fgli_real_mensal[i] = m.fgli_real_hl;
    k.hl_meta_mensal[i] = m.rs_por_hl_meta;
    k.hl_real_mensal[i] = m.rs_por_hl_real;
    k.wqi_meta_mensal[i] = m.wqi_meta;
    k.wqi_real_mensal[i] = m.wqi_real;
  }

  let volume = null;
  try {
    const raw = await kvGet(`${DATA_KEY}__volume`);
    if (raw) volume = JSON.parse(raw);
  } catch (e) { /* sem volume salvo ainda — tudo bem */ }

  const payload = { kpis: Object.values(porCod) };
  if (volume) payload.volume = volume;
  return JSON.stringify(payload);
}

async function saveKpiDataValue(value) {
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch (e) {
    throw new Error('Valor de "' + DATA_KEY + '" não é um JSON válido.');
  }

  const kpis = parsed.kpis || [];

  // 1) atualiza o gatilho de cada KPI na tabela de dimensão
  await Promise.all(kpis.map(async (k) => {
    if (k.gatilho === undefined) return;
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/scl_kpis_dim?kpi_cod=eq.${k.cod}`,
      {
        method: 'PATCH',
        headers: supaHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
        body: JSON.stringify({ gatilho_rs: k.gatilho })
      }
    );
    if (!resp.ok) throw new Error(`Falha ao atualizar gatilho do KPI ${k.cod}: ${resp.status}`);
  }));

  // 2) monta as linhas mensais de todos os KPIs num único upsert em lote
  const linhas = [];
  for (const k of kpis) {
    for (let i = 0; i < 8; i++) {
      linhas.push({
        kpi_cod: k.cod,
        ano: ANO,
        mes_idx: i + 1,
        mes: MESES[i],
        meta_rs: k.meta_mensal?.[i] ?? null,
        real_rs: k.real_mensal?.[i] ?? null,
        fgli_meta_hl: k.fgli_meta_mensal?.[i] ?? null,
        fgli_real_hl: k.fgli_real_mensal?.[i] ?? null,
        rs_por_hl_meta: k.hl_meta_mensal?.[i] ?? null,
        rs_por_hl_real: k.hl_real_mensal?.[i] ?? null,
        wqi_meta: k.wqi_meta_mensal?.[i] ?? null,
        wqi_real: k.wqi_real_mensal?.[i] ?? null,
        atualizado_em: new Date().toISOString()
      });
    }
  }

  if (linhas.length) {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/scl_kpis_mensal?on_conflict=kpi_cod,ano,mes_idx`,
      {
        method: 'POST',
        headers: supaHeaders({
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal'
        }),
        body: JSON.stringify(linhas)
      }
    );
    if (!resp.ok) throw new Error(`Falha ao gravar valores mensais: ${resp.status} ${await resp.text()}`);
  }

  // 3) volume (não faz parte das duas tabelas) fica guardado à parte
  if (parsed.volume) {
    await kvSet(`${DATA_KEY}__volume`, JSON.stringify(parsed.volume));
  }
}

// ---------- upload de fotos para o Supabase Storage ----------

function extrairImagemBase64(dataUrl) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const mime = m[1];
  const ext = mime.split('/')[1].replace('jpeg', 'jpg');
  return { mime, ext, buffer: Buffer.from(m[2], 'base64') };
}

async function trocarFotoPorLink(key, valorTexto) {
  let obj;
  try {
    obj = JSON.parse(valorTexto);
  } catch (e) {
    return valorTexto; // não é um objeto JSON — não tem foto pra tratar
  }
  if (!obj || typeof obj !== 'object' || typeof obj.img !== 'string' || !obj.img.startsWith('data:image')) {
    return valorTexto; // não tem foto em base64 — segue o baile
  }

  const imagem = extrairImagemBase64(obj.img);
  if (!imagem) return valorTexto;

  const caminho = `${key}.${imagem.ext}`;
  const resp = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${caminho}`,
    {
      method: 'POST',
      headers: supaHeaders({ 'Content-Type': imagem.mime, 'x-upsert': 'true' }),
      body: imagem.buffer
    }
  );
  if (!resp.ok) {
    console.warn('Falha ao enviar foto para o Storage:', resp.status, await resp.text());
    return valorTexto; // se der erro, guarda do jeito antigo (base64) em vez de perder a foto
  }

  obj.img = `${SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${caminho}`;
  return JSON.stringify(obj);
}

// ---------- handler principal ----------

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({
      error: 'Variáveis de ambiente do Supabase não encontradas.',
      dica: 'Confira SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY em Settings > Environment Variables e refaça o deploy.'
    });
  }

  const key = req.query.key;
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: 'Parâmetro "key" é obrigatório.' });
  }

  try {
    if (req.method === 'GET') {
      const value = key === DATA_KEY ? await buildKpiDataValue() : await kvGet(key);
      return res.status(200).json({ key, value });
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { /* mantém como string mesmo */ }
      }
      let value = body && Object.prototype.hasOwnProperty.call(body, 'value') ? body.value : body;

      if (key === DATA_KEY) {
        await saveKpiDataValue(value);
      } else {
        if (key.startsWith('scl-record-') && typeof value === 'string') {
          value = await trocarFotoPorLink(key, value);
        }
        await kvSet(key, value);
      }
      return res.status(200).json({ ok: true, key });
    }

    if (req.method === 'DELETE') {
      if (key !== DATA_KEY) await kvDel(key);
      return res.status(200).json({ ok: true, key, deleted: true });
    }

    return res.status(405).json({ error: 'Método não suportado. Use GET, POST ou DELETE.' });
  } catch (err) {
    console.error('Erro no /api/storage:', err);
    return res.status(500).json({ error: 'Erro interno ao acessar o armazenamento.', details: String(err) });
  }
}
