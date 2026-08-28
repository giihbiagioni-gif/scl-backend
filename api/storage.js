// Endpoint único de persistência: GET pra ler, POST pra salvar.
// Fala direto com a API REST do Upstash Redis (sem depender do pacote @vercel/kv),
// aceitando tanto os nomes de variável do "Vercel KV" clássico quanto os do
// Upstash puro — o que a integração tiver injetado, funciona.
const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key){
  const resp = await fetch(`${REST_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REST_TOKEN}` }
  });
  if(!resp.ok) throw new Error(`Upstash GET falhou: ${resp.status}`);
  const data = await resp.json();
  return data.result ?? null;
}

async function redisSet(key, value){
  const resp = await fetch(`${REST_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  if(!resp.ok) throw new Error(`Upstash SET falhou: ${resp.status}`);
}

async function redisDel(key){
  const resp = await fetch(`${REST_URL}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REST_TOKEN}` }
  });
  if(!resp.ok) throw new Error(`Upstash DEL falhou: ${resp.status}`);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if(!REST_URL || !REST_TOKEN){
    return res.status(500).json({
      error: 'Variáveis de ambiente do Redis não encontradas.',
      dica: 'Confira em Settings > Environment Variables e refaça o deploy depois de conectar o banco.',
      variaveis_encontradas: Object.keys(process.env).filter(k => k.includes('KV') || k.includes('UPSTASH') || k.includes('REDIS'))
    });
  }

  const key = req.query.key;
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: 'Parâmetro "key" é obrigatório.' });
  }

  try {
    if (req.method === 'GET') {
      const value = await redisGet(key);
      return res.status(200).json({ key, value });
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch {}
      }
      const value = body && Object.prototype.hasOwnProperty.call(body, 'value') ? body.value : body;
      await redisSet(key, value);
      return res.status(200).json({ ok: true, key });
    }

    if (req.method === 'DELETE') {
      await redisDel(key);
      return res.status(200).json({ ok: true, key, deleted: true });
    }

    return res.status(405).json({ error: 'Método não suportado. Use GET, POST ou DELETE.' });
  } catch (err) {
    console.error('Erro no /api/storage:', err);
    return res.status(500).json({ error: 'Erro interno ao acessar o armazenamento.', details: String(err) });
  }
}
