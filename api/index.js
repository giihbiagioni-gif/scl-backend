export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    ok: true,
    servico: 'SCL Dashboard Backend',
    endpoints: ['/api/storage?key=SEU_KEY (GET/POST)']
  });
}
