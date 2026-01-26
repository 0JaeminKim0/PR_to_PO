import { serve } from '@hono/node-server'
import app from './index.js'

const port = parseInt(process.env.PORT || '3000')

console.log(`🚀 Server starting on port ${port}...`)

serve({
  fetch: app.fetch,
  port
}, (info) => {
  console.log(`✅ Server is running on http://localhost:${info.port}`)
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`)
  console.log(`🔑 ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'configured' : 'NOT configured'}`)
})
