import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// 开发用：POST /__shot 将页面截帧保存到 .shots/ 目录
function shotPlugin() {
  return {
    name: 'dev-shot',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const m = body.match(/^data:image\/(\w+);base64,(.+)$/s);
            const dir = path.resolve('.shots');
            fs.mkdirSync(dir, { recursive: true });
            const name = `shot-${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
            fs.writeFileSync(path.join(dir, name), Buffer.from(m[2], 'base64'));
            res.end(name);
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [shotPlugin()],
});
