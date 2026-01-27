module.exports = {
  apps: [
    {
      name: 'pr-analysis-agent',
      script: 'dist/server.js',
      env: {
        NODE_ENV: 'development',
        PORT: 3000
        // ANTHROPIC_API_KEY는 .dev.vars 파일 또는 환경 변수로 설정
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
}
