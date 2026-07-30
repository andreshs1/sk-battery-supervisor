# Battery Supervisor for SignalK

Battery Supervisor is a SignalK plugin that provides profile-based battery charging supervision using configurable State of Charge (SOC) thresholds.

The plugin evaluates battery SOC against user-defined charge profiles and publishes the resulting charging state to SignalK paths for use by external automation systems.

Battery Supervisor is intentionally **hardware-agnostic**. It does not directly control chargers, relays, MPPTs, inverters, or battery management systems. Instead, it acts as a supervisory decision engine that publishes battery management information which can then be consumed by other systems.

---

# Features

- Configurable battery SOC input path
- Multiple user-defined charge profiles
- Automatic profile identifier generation
- Profile selection persistence across restarts
- Profile switching through:
  - Battery Supervisor web UI
  - REST API
  - SignalK command path
- Hysteresis-based charge enable logic
- Published SignalK charge-control paths
- Human-readable state and reason reporting
- Hardware-independent architecture

---

# Supported Charge Profiles

| Profile | Start Charging Below | Stop Charging At |
|----------|----------|----------|
| Storage | 50% | 60% |
| Harbour | 60% | 70% |
| Daily | 70% | 80% |
| Cruise Prep | 80% | 90% |
| Full Charge | 95% | 100% |

Users can freely add, edit, remove, or reorder profiles.

Profile identifiers are automatically generated from the display label.

| Display Label | Generated ID |
|---------------|-------------|
| Storage | storage |
| Harbour | harbour |
| Daily | daily |
| Cruise Prep | cruise-prep |
| Full Charge | full-charge |

---

# How Battery Supervisor Works

Battery Supervisor continuously monitors a configured battery SOC value and compares it against the currently selected charge profile.

Each profile contains:

- Minimum SOC threshold
- Maximum SOC threshold

Charging is controlled using hysteresis logic.

---

# Design Philosophy

Battery Supervisor is intended to be a reusable battery supervision layer.

It publishes charging decisions into SignalK but leaves actual hardware control to external systems.

Examples include:

- Victron Cerbo GX
- Home Assistant
- Node-RED
- MQTT consumers
- SignalK plugins
- Custom automation scripts
- Future JK BMS integrations

---

# Published SignalK Paths

Default output base path:

```text
electrical.batteries.house.chargeControl
```

Published values:

| Path | Description |
|--------|--------|
| profile | Active profile identifier |
| profileLabel | Active profile display name |
| availableProfiles | Available profile identifiers |
| availableProfileLabels | Available profiles with thresholds |
| minSoc | Active profile minimum SOC |
| maxSoc | Active profile maximum SOC |
| soc | Current battery SOC |
| chargeEnable | Charging permission state |
| state | charging_allowed or charging_blocked |
| reason | Human-readable explanation |
| lastProfileChangeSource | Origin of last profile change |
| lastUpdate | Timestamp of last update |

---

# Example: Victron Cerbo GX Integration

```text
JK BMS
   │
   ▼
SignalK
   │
   ▼
Battery Supervisor
   │
   ├── chargeEnable
   ├── profile
   ├── profileLabel
   │
   ▼
Node-RED / MQTT / Home Assistant
   │
   ▼
Cerbo GX
```

Battery Supervisor determines whether charging should be allowed. External systems consume the published SignalK values and apply the required hardware actions, including DVCC limits, charger control, relay control, MPPT control, and inverter control.

---

# Profile Selection

Profiles may be selected using:

- Battery Supervisor Web UI
- REST API
- SignalK command path

Default command path:

```text
electrical.batteries.house.chargeControl.command.profile
```

Examples:

```text
storage
harbour
daily
cruise-prep
full-charge
```

---

# Future Roadmap

- JK BMS RS485 integration
- Cell voltage monitoring
- Dynamic charge current limiting
- Dynamic discharge current limiting
- Cell balancing awareness
- Victron DVCC integration
- Relay control outputs
- MPPT supervisory control
- Advanced battery protection logic

---

# License

MIT License.
