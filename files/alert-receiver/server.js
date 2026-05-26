const express = require('express')
const bodyParser = require('body-parser')
const sqlite3 = require('sqlite3').verbose()
const path = require('path')

const app = express()

const PORT = process.env.PORT || 3456

const DEFAULT_API_LIMIT = 100
const MAX_API_LIMIT = 2000
const DEFAULT_HTML_LIMIT = 500
const MAX_HTML_LIMIT = 5000

app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json({ limit: '10mb' }))

// Database

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

// Helper

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function formatTimestamp(timestamp) {
    if (!timestamp) return null

    return new Date(timestamp).toLocaleString('en-US', {
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

function severityClass(severity) {
    const value = String(severity || '').toLowerCase()
    if (value === 'critical' || value === 'error') return 'sev-critical'
    if (value === 'warning') return 'sev-warning'
    if (value === 'info') return 'sev-info'
    return 'sev-other'
}

function mapPrtgSeverity(status) {
    const value = String(status || '').toLowerCase()

    if (value.includes('down')) return 'critical'
    if (value.includes('error')) return 'error'
    if (value.includes('warning')) return 'warning'
    if (value.includes('threshold')) return 'warning'
    if (value.includes('breached')) return 'warning'

    return 'info'
}

function mapPrometheusSeverity(severity) {
    const value = String(severity || '').toLowerCase()

    if (value === 'critical') return 'critical'
    if (value === 'warning') return 'warning'
    if (value === 'error') return 'error'

    return 'info'
}

// DB helper

function insertAlert(alert, callback = () => { }) {
    const sql = `
        INSERT INTO alerts (
            source, device, device_id, sensor,
            sensor_id, status, severity, message, last_value,
            priority, group_name, probe, down_time, timestamp, raw
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `

    const values = [
        alert.source, alert.device, alert.device_id, alert.sensor,
        alert.sensor_id, alert.status, alert.severity, alert.message, alert.last_value,
        alert.priority, alert.group_name, alert.probe, alert.down_time, alert.timestamp, alert.raw
    ]

    db.run(sql, values, callback)
}

function getRecentAlerts(limit, callback) {
    db.all(`SELECT * FROM alerts ORDER BY id DESC LIMIT ?`, [limit], callback)
}

function getAlertsBySeverity(level, limit, callback) {
    db.all(`SELECT * FROM alerts WHERE severity = ? ORDER BY id DESC LIMIT ?`, [level, limit], callback)
}

// Normalizers

function normalizePrtgAlert(data) {
    const message = data.message || ''

    try {
        message = decodeURIComponent(message)
    } catch (e) {
        console.log('Warning: Could not decode message, using as-is')
    }

    return {
        source: 'prtg',
        device: data.device || 'Unknown',
        device_id: data.deviceid || null,
        sensor: data.sensor || data.name || 'Unknown',
        sensor_id: data.sensorid || null,
        status: data.status || 'Unknown',
        severity: mapPrtgSeverity(data.status),
        message,
        last_value:
            data.lastvalue && data.lastvalue !== ''
                ? data.lastvalue
                : null,
        priority: data.priority || null,
        group_name: data.group || null,
        probe: data.probe || null,
        down_time:
            data.down && data.down !== ''
                ? data.down
                : null,
        timestamp: new Date().toISOString(),
        raw: JSON.stringify(data)
    }
}

function normalizePrometheusAlert(alert) {
    const labels = alert.labels || {}
    const annotations = alert.annotations || {}

    const alertName = labels.alertname || 'Unknown'
    const instance = labels.instance || 'localhost'

    const status = alert.status || 'firing'
    const statusMapped = status === 'firing' ? 'firing' : 'resolved'

    const summary =
        annotations.summary ||
        annotations.message ||
        `${alertName} on ${instance}`

    const startsAt = alert.startsAt || new Date().toISOString()
    const endsAt = alert.endsAt

    const formattedTimestamp = formatTimestamp(
        status === 'resolved'
            ? endsAt || startsAt
            : startsAt
    )

    const description = annotations.description || ''

    return {
        source: 'prometheus',
        device: instance,
        device_id: null,
        sensor: alertName,
        sensor_id: labels.job || null,
        status: statusMapped,
        severity: mapPrometheusSeverity(labels.severity),
        message: description
            ? `${summary} - ${description}`
            : summary,
        last_value: labels.value || null,
        priority: labels.severity || null,
        group_name: null,
        probe: null,
        down_time: null,
        timestamp: formattedTimestamp,
        raw: JSON.stringify(alert)
    }
}

// Health endpoint
app.get('/health', (req, res) => res.json({ status: 'ok' }))

// PRTG webhook endpoint

app.post('/webhook/prtg', (req, res) => {
    const alert = normalizePrtgAlert(req.body)
    console.log(`[${alert.severity.toUpperCase()}] ${alert.device} - ${alert.sensor}: ${alert.message}`)
    insertAlert(alert, (err) => {
        if (err) {
            console.error('[DB ERROR]', err)

            return res.status(500).json({
                success: false,
                error: err.message
            })
        }
        res.json({
            success: true
        })
    })
})

// Prometheus Alertmanager webhook endpoint

app.post('/webhook/prometheus', (req, res) => {
    const alerts = req.body.alerts || []
    console.log(`[PROMETHEUS] Received ${alerts.length} alert(s)`)
    alerts.forEach((rawAlert) => {
        const alert = normalizePrometheusAlert(rawAlert)
        console.log(`[${alert.severity.toUpperCase()}] ${alert.device} - ${alert.sensor}: ${alert.message}`)
        insertAlert(alert, (err) => {
            if (err) {
                console.error('[DB ERROR]', err)
            }
        })
    })
    res.json({
        success: true,
        received: alerts.length
    })
})

app.get('/alerts', (req, res) => {
    const limit = Math.min(
        parseInt(req.query.limit, 10) || DEFAULT_API_LIMIT,
        MAX_API_LIMIT
    )
    getRecentAlerts(limit, (err, rows) => {
        if (err) {
            return res.status(500).json({
                error: err.message
            })
        }
        res.json(rows)
    })
})

app.get('/alerts/severity/:level', (req, res) => {
    const level = req.params.level
    const limit = Math.min(
        parseInt(req.query.limit, 10) || DEFAULT_API_LIMIT,
        MAX_API_LIMIT
    )
    getAlertsBySeverity(level, limit, (err, rows) => {
        if (err) {
            return res.status(500).json({
                error: err.message
            })
        }
        res.json(rows)
    })
})

app.get(['/'], (req, res) => {
    const limit = Math.min(
        parseInt(req.query.limit, 10) || DEFAULT_HTML_LIMIT,
        MAX_HTML_LIMIT
    )

    //  db.all(`SELECT * FROM alerts ORDER BY timestamp DESC LIMIT ?`, [limit], (err, rows) => {
    getRecentAlerts(limit, (err, rows) => {
        if (err) {
            res.status(500).send(`<pre>DB Error: ${escapeHtml(err.message)}</pre>`)
            return
        }

        const tableRows = rows
            .map((row) => {
                return `
                    <tr>
                        <td>${escapeHtml(formatTimestamp(row.timestamp))}</td>
                        <td>${escapeHtml(row.source)}</td>
                        <td>${escapeHtml(row.device)}</td>
                        <td>${escapeHtml(row.sensor)}</td>
                        <td>${escapeHtml(row.status)}</td>
                        <td>
                            <span class="pill ${severityClass(row.severity)}">
                                ${escapeHtml(row.severity)}
                            </span>
                        </td>
                        <td class="msg" title="${escapeHtml(row.message)}">
                            ${escapeHtml(row.message)}
                        </td>
                    </tr>
                `
            })
            .join('')

        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.send(`
<!doctype html>
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
</html>
        `)
    })
})

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Alert receiver running on port ${PORT}`)
})