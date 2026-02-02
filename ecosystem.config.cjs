const fs = require('fs');
const path = require('path');

// .dev.vars 파일에서 환경 변수 로드
const devVarsPath = path.join(__dirname, '.dev.vars');
const envVars = { NODE_ENV: 'development', PORT: 3000 };

if (fs.existsSync(devVarsPath)) {
  const content = fs.readFileSync(devVarsPath, 'utf-8');
  content.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0) {
      envVars[key.trim()] = valueParts.join('=').trim();
    }
  });
}

module.exports = {
  apps: [
    {
      name: 'pr-analysis-agent',
      script: 'node',
      args: 'dist/server.js',
      env: envVars,
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
}
