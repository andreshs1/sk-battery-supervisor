const test = require('node:test')
const assert = require('node:assert/strict')

const pluginFactory = require('../plugin/index')

const mockApp = {
  debug: () => {},
  error: () => {},
  handleMessage: () => {},
  setPluginStatus: () => {},
  setPluginError: () => {},
  getSelfPath: () => null,
  subscriptionmanager: {
    subscribe: () => {}
  }
}

test('plugin exports a factory function', () => {
  assert.equal(typeof pluginFactory, 'function')
})

test('plugin creates a valid plugin object', () => {
  const plugin = pluginFactory(mockApp)

  assert.equal(plugin.id, 'sk-battery-supervisor')
  assert.equal(typeof plugin.start, 'function')
  assert.equal(typeof plugin.stop, 'function')
  assert.equal(typeof plugin.schema, 'function')
})

test('plugin schema is valid', () => {
  const plugin = pluginFactory(mockApp)

  const schema = plugin.schema()

  assert.equal(schema.type, 'object')
  assert.ok(schema.properties.socPath)
  assert.ok(schema.properties.profiles)
})