const express = require('express')
const bodyParser = require('body-parser')
const sqlite3 = require('sqlite3').verbose()
const path = require('path')

const app = express()
app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json({ limit: '10mb' }))

const dbPath = path.join('/data', 'alerts.db')
const db = new sqlite3.Database(dbPath)

db.run(`
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT,
    device TEXT,
    device_id TEXT,
    sensor TEXT,
    sensor_id TEXT,
    status TEXT,
    severity TEXT,
    message TEXT,
    last_value TEXT,
    priority TEXT,
    group_name TEXT,
    probe TEXT,
    down_time TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    raw TEXT
  )
`)

app.get('/health', (req, res) => res.json({ status: 'ok' }))

// PRTG webhook endpoint
app.post('/webhook/prtg', (req, res) => {
    const data = req.body

    const device = data.device || 'Unknown'
    const status = data.status || 'Unknown'

    let message = data.message || ''
    try {
        message = decodeURIComponent(message)
    } catch (e) {
        console.log('Warning: Could not decode message, using as-is')
    }

    let severity = 'info'
    const statusLower = status.toLowerCase()
    if (statusLower.includes('down')) severity = 'critical'
    else if (statusLower.includes('warning')) severity = 'warning'
    else if (statusLower.includes('error')) severity = 'error'
    else if (statusLower.includes('threshold')) severity = 'warning'
    else if (statusLower.includes('breached')) severity = 'warning'

    const sensorName = data.sensor || data.name || 'Unknown'
    const sensorId = data.sensorid || null
    const lastValue = data.lastvalue && data.lastvalue !== '' ? data.lastvalue : null
    const downTime = data.down && data.down !== '' ? data.down : null

    console.log(`[${severity.toUpperCase()}] ${device} - ${sensorName}: ${message}`)

    db.run(
        `INSERT INTO alerts (
      source, device, device_id, sensor, sensor_id, status, severity,
      message, last_value, priority, group_name, probe, down_time, timestamp, raw
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            'prtg',
            device,
            data.deviceid || null,
            sensorName,
            sensorId,
            status,
            severity,
            message,
            lastValue,
            data.priority || null,
            data.group || null,
            data.probe || null,
            downTime,
            data.datetime || new Date().toISOString(),
            JSON.stringify(data)
        ],
        (err) => {
            if (err) {
                console.error('DB Error:', err)
                res.status(500).json({ error: err.message })
            } else {
                res.json({ success: true })
            }
        }
    )
})

function formatTimestamp(timestamp) {
    if (!timestamp) return null

    const date = new Date(timestamp)

    return date
        .toLocaleString('en-US', {
            month: 'numeric',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        })
        .replace(',', '')
}

// Prometheus Alertmanager webhook endpoint
app.post('/webhook/prometheus', (req, res) => {
    const data = req.body
    const alerts = data.alerts || []

    console.log(`[PROMETHEUS] Received ${alerts.length} alert(s)`)

    alerts.forEach((alert) => {
        const labels = alert.labels || {}
        const annotations = alert.annotations || {}

        const alertName = labels.alertname || 'Unknown'
        const instance = labels.instance || 'localhost'
        const severity = labels.severity || 'warning'
        const status = alert.status || 'firing'
        const summary = annotations.summary || annotations.message || `${alertName} on ${instance}`
        const description = annotations.description || ''
        const startsAt = alert.startsAt || new Date().toISOString()
        const endsAt = alert.endsAt

        const message = description ? `${summary} - ${description}` : summary

        const severityMapped =
            severity === 'critical' ? 'critical' : severity === 'warning' ? 'warning' : 'info'

        const statusMapped = status === 'firing' ? 'firing' : 'resolved'

        console.log(`[${severityMapped.toUpperCase()}] ${instance} - ${alertName}: ${message}`)

        const formattedTimestamp = formatTimestamp(
            status === 'resolved'
                ? endsAt || startsAt
                : startsAt
        )

        db.run(
            `INSERT INTO alerts (
        source, device, device_id, sensor, sensor_id, status, severity,
        message, last_value, priority, group_name, probe, down_time, timestamp, raw
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                'prometheus',
                instance,
                null,
                alertName,
                labels.job || null,
                statusMapped,
                severityMapped,
                message,
                labels.value || null,
                severity,
                null,
                null,
                null,
                formattedTimestamp,
                JSON.stringify(alert)
            ],
            (err) => {
                if (err) console.error('DB Error:', err)
            }
        )
    })

    res.json({ success: true, received: alerts.length })
})

app.get('/alerts', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 2000)
    //  db.all(`SELECT * FROM alerts ORDER BY timestamp DESC LIMIT ?`, [limit], (err, rows) => {
    db.all(`SELECT * FROM alerts ORDER BY id DESC LIMIT ?`, [limit], (err, rows) => {
        if (err) res.status(500).json({ error: err.message })
        else res.json(rows)
    })
})

app.get('/alerts/severity/:level', (req, res) => {
    const level = req.params.level
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 2000)
    // db.all(`SELECT * FROM alerts WHERE severity = ? ORDER BY timestamp DESC LIMIT ?`,[level, limit],(err, rows) => {
        db.all(`SELECT * FROM alerts WHERE severity = ? ORDER BY id DESC LIMIT ?`,[level, limit],(err, rows) => {
            if (err) res.status(500).json({ error: err.message })
            else res.json(rows)
        }
    )
})

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function severityClass(severity) {
    const value = String(severity || '').toLowerCase()
    if (value === 'critical' || value === 'error') return 'sev-critical'
    if (value === 'warning') return 'sev-warning'
    if (value === 'info') return 'sev-info'
    return 'sev-other'
}

app.get(['/'], (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000)

    //  db.all(`SELECT * FROM alerts ORDER BY timestamp DESC LIMIT ?`, [limit], (err, rows) => {
    db.all(`SELECT * FROM alerts ORDER BY id DESC LIMIT ?`, [limit], (err, rows) => {
        if (err) {
            res.status(500).send(`<pre>DB Error: ${escapeHtml(err.message)}</pre>`)
            return
        }

        const tableRows = rows
            .map(
                (row) => `
          <tr>
            <td>${escapeHtml(row.timestamp)}</td>
            <td>${escapeHtml(row.source)}</td>
            <td>${escapeHtml(row.device)}</td>
            <td>${escapeHtml(row.sensor)}</td>
            <td>${escapeHtml(row.status)}</td>
            <td><span class="pill ${severityClass(row.severity)}">${escapeHtml(row.severity)}</span></td>
            <td class="msg" title="${escapeHtml(row.message)}">${escapeHtml(row.message)}</td>
          </tr>`
            )
            .join('')

        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Alert Receiver - Alerts</title>
  <style>
    :root { color-scheme: dark; }
    body { font-family: Inter, system-ui, Arial, sans-serif; background: #0b1220; color: #e5e7eb; margin: 0; }
    .wrap { max-width: 1280px; margin: 0 auto; padding: 20px; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    .meta { color: #9ca3af; margin-bottom: 16px; display: flex; gap: 16px; flex-wrap: wrap; }
    a { color: #93c5fd; text-decoration: none; }
    .panel { background: #111827; border: 1px solid #1f2937; border-radius: 10px; overflow: hidden; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #1f2937; text-align: left; font-size: 13px; vertical-align: top; }
    th { background: #0f172a; color: #cbd5e1; position: sticky; top: 0; z-index: 1; }
    tr:hover { background: #0f1a2f; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
    .sev-critical { background: #7f1d1d; color: #fecaca; }
    .sev-warning { background: #78350f; color: #fde68a; }
    .sev-info { background: #1e3a8a; color: #bfdbfe; }
    .sev-other { background: #374151; color: #d1d5db; }
    .msg { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Alerts</h1>
    <div class="meta">
      <span>Total shown: <strong>${rows.length}</strong></span>
      <span>Auto-refresh: <strong>30s</strong></span>
      <span>JSON API: <a href="/alerts?limit=${limit}">/alerts</a></span>
    </div>

    <div class="panel">
      <table>
        <thead>
          <tr>
            <th style="width: 190px;">Timestamp</th>
            <th style="width: 95px;">Source</th>
            <th style="width: 180px;">Device / Instance</th>
            <th style="width: 200px;">Sensor / Alert</th>
            <th style="width: 110px;">Status</th>
            <th style="width: 95px;">Severity</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows || '<tr><td colspan="7">No alerts yet.</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>
  <script>
    setTimeout(() => location.reload(), 30000)
  </script>
</body>
</html>`)
    })
})

const PORT = process.env.PORT || 3456
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Alert receiver running on port ${PORT}`)
})
