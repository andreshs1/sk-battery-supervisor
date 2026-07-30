/*
 * sk-battery-supervisor
 *
 * Battery Supervisor for SignalK.
 *
 * Current function:
 *   - Reads configurable SOC input path
 *   - Supports configurable charge profiles with minimum and maximum SOC thresholds
 *   - Allows active profile selection
 *   - Publishes chargeEnable based on configurable SOC ranges
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
    'Battery supervisor for configurable charge profiles, SOC range-based charging logic, and publication of charge-control state to SignalK paths for use by external automation and charging-control systems.'
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
      label: 'Storage',
      minSoc: 50,
      maxSoc: 60
    },
    {
      label: 'Harbour',
      minSoc: 60,
      maxSoc: 70
    },
    {
      label: 'Daily',
      minSoc: 70,
      maxSoc: 80
    },
    {
      label: 'Cruise Prep',
      minSoc: 80,
      maxSoc: 90
    },
    {
      label: 'Full Charge',
      minSoc: 95,
      maxSoc: 100
    }
  ]

  function makeProfileId(label) {
    return String(label || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  }

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
      const id = cleanProfileId(
        profile.id || makeProfileId(profile.label)
      )

      if (!id || seen.has(id)) {
        return
      }

      seen.add(id)

      result.push({
        id,
        label: String(profile.label || id),
        minSoc: clamp(safeNumber(profile.minSoc, 70), 0, 100),
        maxSoc: clamp(safeNumber(profile.maxSoc, 80), 0, 100)
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
    return ( 
      options.outputBasePath ||
      'electrical.batteries.house.chargeControl'
    )
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
        minSoc: p.minSoc,
        maxSoc: p.maxSoc
      }))
    )
    emitPath(`${basePath}.minSoc`, profile.minSoc)
    emitPath(`${basePath}.maxSoc`, profile.maxSoc)
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

    const minSoc = profile.minSoc
    const maxSoc = profile.maxSoc

    if (currentSocPct === null) {
      return {
        profile,
        decision: {
          chargeEnable: false,
          minSoc,
          maxSoc,
          reason: 'No valid SOC available'
        }
      }
    }

    /*
    * Latching min/max SOC logic.
    *
    * If charging is allowed:
    *   allow until SOC >= maxSoc
    *
    * If charging is blocked:
    *   block until SOC <= minSoc
    */
    let nextChargeEnable = chargeEnable

    if (nextChargeEnable === null) {
      nextChargeEnable = currentSocPct < maxSoc
    }
    else if (
      nextChargeEnable === true &&
      currentSocPct >= maxSoc
    ) {
      nextChargeEnable = false
    }
    else if (
      nextChargeEnable === false &&
      currentSocPct <= minSoc
    ) {
      nextChargeEnable = true
    }
    
    let reason

    if (nextChargeEnable) {
      reason =
        `Charging enabled. SOC ${currentSocPct.toFixed(
          1
        )}% is below stop threshold ${maxSoc}%`
    }
    else if (currentSocPct >= maxSoc) {
      reason =
        `Charging stopped. SOC ${currentSocPct.toFixed(
          1
        )}% reached ${maxSoc}%`
    }
    else {
      reason =
        `Waiting until SOC falls below ${minSoc}%`
    }

    return {
      profile,
      decision: {
        chargeEnable: nextChargeEnable,
        minSoc,
        maxSoc,
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
      }, range ${profile.minSoc}% - ${profile.maxSoc}%, chargeEnable=${chargeEnable}`
    )
  }

  function persistSelectedProfile() {
    if (!app.savePluginOptions) {
      return
    }

    const savedOptions = Object.assign({}, options, {
      selectedProfileId: activeProfileId,
      selectedProfileLabel: getActiveProfile().label
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
    options.selectedProfileId = profile.id
    options.selectedProfileLabel = profile.label
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
         * 
         */
        socPath: '',

        /*
         * Outputs from this plugin.
         */
        outputBasePath: 'electrical.batteries.house.chargeControl',

        /*
        * Optional input path.
        * External systems may write the generated profile identifier
        * (for example: storage, harbour, daily, cruise-prep, full-charge).
        */
       selectedProfileId: null,
       selectedProfileLabel: null,
        profileCommandPath:
          'electrical.batteries.house.chargeControl.command.profile',

        publishIntervalSeconds: 30,
        profiles: DEFAULT_PROFILES
      },
      config || {}
    )

    options.profiles = normalizeProfiles(options.profiles)

    if (!options.socPath || !options.socPath.trim()) {
      app.setPluginError(
        'Battery SOC input path must be configured'
      )
      return
    }

    const profiles = getProfiles()

    activeProfileId = cleanProfileId(options.selectedProfileId)

    if (!getProfileById(activeProfileId)) {
      activeProfileId = profiles.length ? profiles[0].id : null
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
        minSoc: profile.minSoc,
        maxSoc: profile.maxSoc,
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
        'profileCommandPath'
      ],
      properties: {
        socPath: {
          type: 'string',
          title: 'Battery SOC input path',
          default: '',
          description:
            'SignalK path for battery state of charge. Accepts either 0.0-1.0 or 0-100.'
        },
        outputBasePath: {
          type: 'string',
          title: 'Output base path',
          default: 'electrical.batteries.house.chargeControl',
          description:
            'Base SignalK path where Battery Supervisor output values will be published.'
        },
        profileCommandPath: {
          type: 'string',
          title: 'Profile command input path',
          default: 'electrical.batteries.house.chargeControl.command.profile',
          description:
            'Optional SignalK path where an external system such as Home Assistant can write the requested profile id.'
        },
        selectedProfileLabel: {
          type: 'string',
          title: 'Selected profile',
          readOnly: true,
          description:
            'Currently selected charge profile. Updated automatically when a profile is selected from the Battery Supervisor web page, REST API, or SignalK command path.'
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
            'Add, remove, or edit charge profiles. Profile identifiers are generated automatically from the display label.',
          items: {
            type: 'object',
            required: ['label', 'minSoc', 'maxSoc'],
            properties: {
              label: {
                type: 'string',
                title: 'Display label'
              },
              minSoc: {
                type: 'number',
                title: 'Start charging below (%)',
                minimum: 0,
                maximum: 100
              },
              maxSoc: {
                type: 'number',
                title: 'Stop charging at (%)',
                minimum: 0,
                maximum: 100
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