/*
 * sk-battery-supervisor
 *
 * Battery Supervisor for SignalK.
 *
 * Current function:
 *   - Reads configurable SOC input path
 *   - Supports configurable charge profiles
 *   - Allows active profile selection
 *   - Publishes chargeEnable based on SOC target and hysteresis
 *   - Exposes REST API for Home Assistant / dashboards
 *   - Supports SignalK command path for external profile selection
 *
 * Future function:
 *   - JK BMS RS485 cell-voltage limits
 *   - balancing awareness
 *   - Cerbo GX relay command path
 *   - MPPT remote on/off control
 */

module.exports = function (app) {
  const plugin = {}

  plugin.id = 'sk-battery-supervisor'
  plugin.name = 'Battery Supervisor'
  plugin.description =
    'Battery supervisor for configurable charge profiles and future JK BMS / Cerbo GX relay control.'

  let unsubscribes = []
  let timer = null
  let options = {}

  let currentSocPct = null
  let chargeEnable = null
  let lastReason = 'Plugin not started'
  let activeProfileId = null
  let lastProfileChangeSource = 'startup'

  const DEFAULT_PROFILES = [
    {
      id: 'storage',
      label: 'Storage',
      targetSoc: 60,
      hysteresis: 5
    },
    {
      id: 'harbor',
      label: 'Harbor',
      targetSoc: 70,
      hysteresis: 5
    },
    {
      id: 'daily',
      label: 'Daily',
      targetSoc: 80,
      hysteresis: 5
    },
    {
      id: 'cruise',
      label: 'Cruise Prep',
      targetSoc: 90,
      hysteresis: 5
    },
    {
      id: 'full',
      label: 'Full',
      targetSoc: 100,
      hysteresis: 3
    }
  ]

  function safeNumber(value, fallback) {
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value))
  }

  function cleanProfileId(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
  }

  function normalizeProfiles(rawProfiles) {
    const source =
      Array.isArray(rawProfiles) && rawProfiles.length > 0
        ? rawProfiles
        : DEFAULT_PROFILES

    const seen = new Set()
    const result = []

    source.forEach((profile) => {
      const id = cleanProfileId(profile.id)

      if (!id || seen.has(id)) {
        return
      }

      seen.add(id)

      result.push({
        id,
        label: String(profile.label || id),
        targetSoc: clamp(safeNumber(profile.targetSoc, 80), 0, 100),
        hysteresis: clamp(safeNumber(profile.hysteresis, 5), 0, 50)
      })
    })

    if (result.length === 0) {
      return DEFAULT_PROFILES
    }

    return result
  }

  function getProfiles() {
    return normalizeProfiles(options.profiles)
  }

  function getProfileById(profileId) {
    const profiles = getProfiles()
    const cleanId = cleanProfileId(profileId)

    return profiles.find((p) => p.id === cleanId) || null
  }

  function getActiveProfile() {
    const profiles = getProfiles()

    if (activeProfileId) {
      const selected = getProfileById(activeProfileId)
      if (selected) {
        return selected
      }
    }

    const configuredSelected =
      cleanProfileId(options.selectedProfile) ||
      cleanProfileId(options.defaultProfile)

    const configuredProfile = getProfileById(configuredSelected)

    if (configuredProfile) {
      return configuredProfile
    }

    const daily = getProfileById('daily')
    if (daily) {
      return daily
    }

    return profiles[0]
  }

  function normalizeSocToPercent(rawValue) {
    if (rawValue === null || rawValue === undefined) {
      return null
    }

    const value = Number(rawValue)

    if (!Number.isFinite(value)) {
      return null
    }

    /*
     * SignalK SOC is commonly 0.0-1.0.
     * Some sources publish 0-100.
     * Accept both.
     */
    if (value <= 1.2) {
      return clamp(value * 100, 0, 100)
    }

    return clamp(value, 0, 100)
  }

  function emitPath(path, value) {
    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            {
              path,
              value
            }
          ]
        }
      ]
    })
  }

  function getBasePath() {
    return options.outputBasePath || 'electrical.batteries.277.chargeControl'
  }

  function emitAll(profile, decision) {
    const basePath = getBasePath()
    const profiles = getProfiles()

    emitPath(`${basePath}.profile`, profile.id)
    emitPath(`${basePath}.profileLabel`, profile.label)
    emitPath(`${basePath}.availableProfiles`, profiles.map((p) => p.id))
    emitPath(
      `${basePath}.availableProfileLabels`,
      profiles.map((p) => ({
        id: p.id,
        label: p.label,
        targetSoc: p.targetSoc,
        hysteresis: p.hysteresis
      }))
    )
    emitPath(`${basePath}.targetSoc`, profile.targetSoc)
    emitPath(`${basePath}.resumeSoc`, decision.resumeSoc)
    emitPath(`${basePath}.hysteresis`, profile.hysteresis)
    emitPath(`${basePath}.soc`, currentSocPct)
    emitPath(`${basePath}.chargeEnable`, decision.chargeEnable)
    emitPath(
      `${basePath}.state`,
      decision.chargeEnable ? 'charging_allowed' : 'charging_blocked'
    )
    emitPath(`${basePath}.reason`, decision.reason)
    emitPath(`${basePath}.lastProfileChangeSource`, lastProfileChangeSource)
    emitPath(`${basePath}.lastUpdate`, new Date().toISOString())
  }

  function calculateDecision() {
    const profile = getActiveProfile()

    const targetSoc = clamp(safeNumber(profile.targetSoc, 80), 0, 100)
    const hysteresis = clamp(safeNumber(profile.hysteresis, 5), 0, 50)
    const resumeSoc = clamp(targetSoc - hysteresis, 0, 100)

    if (currentSocPct === null) {
      return {
        profile,
        decision: {
          chargeEnable: false,
          resumeSoc,
          reason: 'No valid SOC available'
        }
      }
    }

    /*
     * Latching hysteresis.
     *
     * If charging is allowed:
     *   allow until SOC >= target
     *
     * If charging is blocked:
     *   block until SOC <= resume SOC
     */

    let nextChargeEnable = chargeEnable

    if (nextChargeEnable === null) {
      nextChargeEnable = currentSocPct < targetSoc
    } else if (nextChargeEnable === true && currentSocPct >= targetSoc) {
      nextChargeEnable = false
    } else if (nextChargeEnable === false && currentSocPct <= resumeSoc) {
      nextChargeEnable = true
    }

    let reason

    if (nextChargeEnable) {
      reason = `SOC ${currentSocPct.toFixed(
        1
      )}% is below target ${targetSoc}%`
    } else if (currentSocPct >= targetSoc) {
      reason = `SOC target reached: ${currentSocPct.toFixed(
        1
      )}% >= ${targetSoc}%`
    } else {
      reason = `Charging held off by hysteresis until SOC <= ${resumeSoc}%`
    }

    return {
      profile,
      decision: {
        chargeEnable: nextChargeEnable,
        resumeSoc,
        reason
      }
    }
  }

  function updateDecision() {
    const result = calculateDecision()
    const profile = result.profile
    const decision = result.decision

    activeProfileId = profile.id
    chargeEnable = decision.chargeEnable
    lastReason = decision.reason

    emitAll(profile, decision)

    app.setPluginStatus(
      `${profile.label}: SOC ${
        currentSocPct === null ? 'unknown' : currentSocPct.toFixed(1) + '%'
      }, target ${profile.targetSoc}%, chargeEnable=${chargeEnable}`
    )
  }

  function persistSelectedProfile() {
    if (!app.savePluginOptions) {
      return
    }

    const savedOptions = Object.assign({}, options, {
      selectedProfile: activeProfileId
    })

    app.savePluginOptions(savedOptions, (err) => {
      if (err) {
        app.error(`${plugin.id}: failed to save selected profile: ${err}`)
      }
    })
  }

  function setActiveProfile(profileId, source, persist) {
    const profile = getProfileById(profileId)

    if (!profile) {
      return {
        ok: false,
        error: 'Invalid profile',
        requested: profileId,
        availableProfiles: getProfiles().map((p) => p.id)
      }
    }

    activeProfileId = profile.id
    options.selectedProfile = profile.id
    lastProfileChangeSource = source || 'unknown'

    /*
     * Reset hysteresis latch when profile changes.
     * This makes the new target take effect immediately.
     */
    chargeEnable = null

    if (persist !== false) {
      persistSelectedProfile()
    }

    updateDecision()

    return {
      ok: true,
      activeProfile: activeProfileId,
      profile,
      chargeEnable,
      reason: lastReason
    }
  }

  function handleDelta(delta) {
    if (!delta || !delta.updates) {
      return
    }

    delta.updates.forEach((update) => {
      if (!update.values) {
        return
      }

      update.values.forEach((valueUpdate) => {
        if (valueUpdate.path === options.socPath) {
          const soc = normalizeSocToPercent(valueUpdate.value)

          if (soc !== null) {
            currentSocPct = soc
            updateDecision()
          }
        }

        if (
          options.profileCommandPath &&
          valueUpdate.path === options.profileCommandPath
        ) {
          const requestedProfile = String(valueUpdate.value || '').trim()

          const result = setActiveProfile(
            requestedProfile,
            'SignalK command path',
            true
          )

          if (!result.ok) {
            app.error(
              `${plugin.id}: invalid profile command "${requestedProfile}"`
            )
          }
        }
      })
    })
  }

  plugin.start = function (config) {
    options = Object.assign(
      {
        /*
         * This is configurable in the plugin settings.
         * Your system currently uses:
         * electrical.batteries.277.capacity.stateOfCharge
         */
        socPath: 'electrical.batteries.277.capacity.stateOfCharge',

        /*
         * Outputs from this plugin.
         */
        outputBasePath: 'electrical.batteries.277.chargeControl',

        /*
         * Optional input path.
         * Home Assistant or another system may write a profile id here:
         * storage / harbor / daily / cruise / full / custom profile id
         */
        profileCommandPath:
          'electrical.batteries.277.chargeControl.command.profile',

        defaultProfile: 'daily',
        selectedProfile: 'daily',
        publishIntervalSeconds: 30,
        profiles: DEFAULT_PROFILES
      },
      config || {}
    )

    options.profiles = normalizeProfiles(options.profiles)

    activeProfileId =
      cleanProfileId(options.selectedProfile) ||
      cleanProfileId(options.defaultProfile) ||
      'daily'

    if (!getProfileById(activeProfileId)) {
      activeProfileId = getActiveProfile().id
    }

    chargeEnable = null
    lastReason = 'Waiting for SOC'
    lastProfileChangeSource = 'startup'

    app.debug(`${plugin.name} started`)

    const initialSoc = app.getSelfPath(options.socPath)
    const initialSocPct = normalizeSocToPercent(initialSoc)

    if (initialSocPct !== null) {
      currentSocPct = initialSocPct
    }

    const subscriptionPaths = [
      {
        path: options.socPath,
        period: 1000
      }
    ]

    if (options.profileCommandPath) {
      subscriptionPaths.push({
        path: options.profileCommandPath,
        period: 1000
      })
    }

    const subscription = {
      context: 'vessels.self',
      subscribe: subscriptionPaths
    }

    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      (err) => {
        app.error(`${plugin.id} subscription error: ${err}`)
      },
      handleDelta
    )

    const intervalSeconds = clamp(
      safeNumber(options.publishIntervalSeconds, 30),
      5,
      3600
    )

    timer = setInterval(updateDecision, intervalSeconds * 1000)

    updateDecision()
  }

  plugin.stop = function () {
    if (timer) {
      clearInterval(timer)
      timer = null
    }

    unsubscribes.forEach((unsubscribe) => {
      try {
        unsubscribe()
      } catch (e) {
        app.error(`${plugin.id} unsubscribe error: ${e.message}`)
      }
    })

    unsubscribes = []

    app.setPluginStatus('Stopped')
  }

  /*
   * REST API
   *
   * GET  /plugins/sk-battery-supervisor/status
   * GET  /plugins/sk-battery-supervisor/profiles
   * GET  /plugins/sk-battery-supervisor/profile
   * PUT  /plugins/sk-battery-supervisor/profile
   */

  plugin.registerWithRouter = function (router) {
    router.get('/status', (req, res) => {
      const profile = getActiveProfile()

      res.json({
        plugin: plugin.id,
        activeProfile: profile.id,
        profileLabel: profile.label,
        targetSoc: profile.targetSoc,
        hysteresis: profile.hysteresis,
        resumeSoc: clamp(profile.targetSoc - profile.hysteresis, 0, 100),
        currentSoc: currentSocPct,
        chargeEnable,
        reason: lastReason,
        socPath: options.socPath,
        outputBasePath: getBasePath(),
        profileCommandPath: options.profileCommandPath,
        lastProfileChangeSource,
        availableProfiles: getProfiles()
      })
    })

    router.get('/profiles', (req, res) => {
      const activeProfile = getActiveProfile()

      res.json({
        activeProfile: activeProfile.id,
        profiles: getProfiles()
      })
    })

    router.get('/profile', (req, res) => {
      const profile = getActiveProfile()

      res.json({
        activeProfile: profile.id,
        profile
      })
    })

    router.put('/profile', (req, res) => {
      const requested = req.body && req.body.profile

      const result = setActiveProfile(requested, 'REST API', true)

      if (!result.ok) {
        res.status(400).json(result)
        return
      }

      res.json(result)
    })
  }

  plugin.statusMessage = function () {
    const profile = getActiveProfile()

    return `${profile.label}: SOC ${
      currentSocPct === null ? 'unknown' : currentSocPct.toFixed(1) + '%'
    }, chargeEnable=${chargeEnable}, ${lastReason}`
  }

  plugin.schema = function () {
    return {
      type: 'object',
      required: [
        'socPath',
        'outputBasePath',
        'profileCommandPath',
        'defaultProfile',
        'selectedProfile'
      ],
      properties: {
        socPath: {
          type: 'string',
          title: 'Battery SOC input path',
          default: 'electrical.batteries.277.capacity.stateOfCharge',
          description:
            'SignalK path for battery state of charge. Accepts either 0.0-1.0 or 0-100.'
        },
        outputBasePath: {
          type: 'string',
          title: 'Output base path',
          default: 'electrical.batteries.277.chargeControl',
          description:
            'Base SignalK path where Battery Supervisor output values will be published.'
        },
        profileCommandPath: {
          type: 'string',
          title: 'Profile command input path',
          default: 'electrical.batteries.277.chargeControl.command.profile',
          description:
            'Optional SignalK path where an external system such as Home Assistant can write the requested profile id.'
        },
        defaultProfile: {
          type: 'string',
          title: 'Default profile id',
          default: 'daily',
          description:
            'Profile id used as fallback on startup if selected profile is invalid.'
        },
        selectedProfile: {
          type: 'string',
          title: 'Selected profile id',
          default: 'daily',
          description:
            'Currently selected profile id. This can also be changed from the Battery Supervisor web page or REST API.'
        },
        publishIntervalSeconds: {
          type: 'number',
          title: 'Republish interval seconds',
          default: 30,
          minimum: 5,
          maximum: 3600
        },
        profiles: {
          type: 'array',
          title: 'Charge profiles',
          description:
            'Add, remove, or edit charge profiles. The id is the value used by REST, Home Assistant, and the selector page.',
          items: {
            type: 'object',
            required: ['id', 'label', 'targetSoc', 'hysteresis'],
            properties: {
              id: {
                type: 'string',
                title: 'Profile id',
                description:
                  'Short id, lowercase recommended, for example: storage, daily, cruise, full.'
              },
              label: {
                type: 'string',
                title: 'Display label'
              },
              targetSoc: {
                type: 'number',
                title: 'Target SOC percent',
                minimum: 0,
                maximum: 100
              },
              hysteresis: {
                type: 'number',
                title: 'Hysteresis percent',
                minimum: 0,
                maximum: 50
              }
            }
          },
          default: DEFAULT_PROFILES
        }
      }
    }
  }

  return plugin
}