# Battery Supervisor

Battery Supervisor is a SignalK plugin and WebApp that provides configurable battery charging profiles and charging control logic for marine electrical systems.

The plugin allows users to select configurable charge profiles such as Storage, Harbor, Daily, Cruise, and Full, each with its own target SOC and hysteresis settings. It continuously monitors battery state of charge and determines whether charging should be enabled or blocked based on the active profile.

Battery Supervisor is designed to integrate with SignalK, MQTT, Home Assistant, Grafana, Node-RED, and marine charging systems while keeping charging policy decisions centralized within SignalK.

## Features

- SignalK server plugin
- SignalK WebApp
- Configurable battery SOC input path
- Configurable charging profiles
- User-selectable charge profiles
- Target SOC and hysteresis management
- Charge enable / disable logic
- MQTT-friendly architecture
- Home Assistant integration
- REST API for profile management

## Default Profiles

| Profile | Target SOC |
|----------|-----------|
| Storage | 60% |
| Harbor | 70% |
| Daily | 80% |
| Cruise | 90% |
| Full | 100% |

Profiles can be modified, removed, or new profiles can be created through the plugin configuration.

## Main SignalK Outputs

Default output path:

```text
electrical.batteries.277.chargeControl
```

Primary outputs:

```text
profile
profileLabel
targetSoc
resumeSoc
soc
chargeEnable
state
reason
lastUpdate
```

The most important output is:

```text
electrical.batteries.277.chargeControl.chargeEnable
```

which can be consumed by MQTT, Home Assistant, Node-RED, dashboards, or future charger-control integrations.

## REST API

Get current status:

```http
GET /plugins/sk-battery-supervisor/status
```

Get available profiles:

```http
GET /plugins/sk-battery-supervisor/profiles
```

Change active profile:

```http
PUT /plugins/sk-battery-supervisor/profile
```

Example:

```json
{
  "profile": "daily"
}
```

PowerShell example:

```powershell
Invoke-RestMethod `
  -Method Put `
  -Uri http://localhost:3000/plugins/sk-battery-supervisor/profile `
  -ContentType "application/json" `
  -Body '{"profile":"daily"}'
```

## Home Assistant Integration

Battery Supervisor is designed to work with existing SignalK MQTT bridges.

Typical flow:

```text
Home Assistant
      ↓
     MQTT
      ↓
 SignalK
      ↓
Battery Supervisor
      ↓
 SignalK Paths
      ↓
 MQTT / Dashboards / Automation
```

## Roadmap

Planned future capabilities include:

- Dynamic charging-current control
- Battery-condition-aware charging
- Relay-based charger control
- Charging source coordination
- Victron Cerbo GX integration
- Advanced automation logic
- Historical charging analytics

## License

MIT License
