import { InstanceBase, runEntrypoint, InstanceStatus } from '@companion-module/base'
import WebSocket from 'ws'
import objectPath from 'object-path'
import { upgradeScripts } from './upgrade.js'
import { initActions } from './actions.js'
import { initFeedbacks } from './feedback.js'

class WebsocketInstance extends InstanceBase {
	isInitialized = false
	ws = null
	reconnect_timer = null

	presets = []
	boolChoices = []
	floatChoices = []
	intChoices = []
	stringChoices = []
	textChoices = []
	nameChoices = []

	functions = []

	lastBoolValues = new Map()
	subscriptions = new Map()

	_httpQueue = []

	_catalogRefreshTimer = null

	async init(config) {
		this.config = config
		this._clearCaches()
		await this._resetWebSocket()

		if (this.config.ip && this.config.port) {
			try {
				await this.connectWebSocket()
				await this.fetchPresets()
				await this.refreshCatalogs()
				await this.ensurePresetSubscriptions()
				if (typeof this.setConfigFields === 'function') {
					this.setConfigFields(this.getConfigFields())
				}
			} catch (err) {
				this.log('error', `WebSocket connection error: ${err}`)
				this.updateStatus(InstanceStatus.BadConfig, 'WebSocket connection failed')
			}
		}

		this.isInitialized = true
		this.updateVariables()
		await initActions(this)
		initFeedbacks(this)
		this.subscribeFeedbacks?.()
		this._startFeedbackPolling()
	}

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Information',
				value:
					'<strong>Unreal Remote Control (WebSocket)</strong> — discovers Preset properties & functions and exposes them as actions/feedbacks. ',
			},
			{
				type: 'checkbox',
				id: 'reconnect',
				label: 'Reconnect',
				tooltip: 'Reconnect on error (5s)',
				width: 6,
				default: true,
			},
			{
				type: 'checkbox',
				id: 'debug_messages',
				label: 'Debug messages',
				tooltip: 'Log WS frames',
				width: 6,
				default: false,
			},
			{
				type: 'textinput',
				id: 'ip',
				label: 'Unreal Engine WebSocket IP',
				default: '127.0.0.1',
				width: 6,
				required: true,
			},
			{ type: 'number', id: 'port', label: 'Unreal Engine WebSocket Port', default: 30020, width: 6, required: true },
			{
				type: 'checkbox',
				id: 'feedback_polling',
				label: 'Feedback polling fallback',
				tooltip: 'Periodically re-check feedbacks in case events are missed.',
				width: 6,
				default: true,
			},
			{
				type: 'number',
				id: 'feedback_poll_ms',
				label: 'Polling interval (ms)',
				tooltip: 'How often to re-evaluate feedbacks when polling is enabled.',
				width: 6,
				default: 1000,
				min: 250,
			},
		]
	}

	async destroy() {
		this.isInitialized = false
		if (this.reconnect_timer) {
			clearTimeout(this.reconnect_timer)
			this.reconnect_timer = null
		}
		this._stopFeedbackPolling()
		try {
			for (const p of this.presets) await this._unregisterPreset(p)
		} catch {}
		await this._resetWebSocket()
	}

	async _unregisterPreset(preset) {
		if (!this.ws || this.ws.readyState !== 1 || !preset) return
		const payload = { MessageName: 'preset.unregister', Parameters: { PresetName: preset } }
		this.ws.send(JSON.stringify(payload))
	}

	async configUpdated(config) {
		const oldconfig = { ...this.config }
		this.config = config

		const addrChanged = oldconfig['ip'] !== config['ip'] || oldconfig['port'] !== config['port']
		const pollChanged =
			oldconfig['feedback_polling'] !== config['feedback_polling'] ||
			Number(oldconfig['feedback_poll_ms']) !== Number(config['feedback_poll_ms'])

		if (addrChanged) {
			await this._resetWebSocket()
			this._clearCaches()

			if (this.config.ip && this.config.port) {
				try {
					await this.connectWebSocket()
					await this.fetchPresets()
					await this.refreshCatalogs()
					await this.ensurePresetSubscriptions()
					if (typeof this.setConfigFields === 'function') {
						this.setConfigFields(this.getConfigFields())
					}
					await initActions(this)
					initFeedbacks(this)
				} catch (err) {
					this.log('error', `WebSocket connection error: ${err}`)
					this.updateStatus(InstanceStatus.BadConfig, 'WebSocket connection failed')
				}
			}
		}

		if (pollChanged) {
			this._startFeedbackPolling()
		}
	}

	_clearCaches() {
		this.presets = []
		this.boolChoices = []
		this.floatChoices = []
		this.intChoices = []
		this.stringChoices = []
		this.textChoices = []
		this.nameChoices = []
		this.enumPropChoices = []
		this.functions = []
		this.lastBoolValues = new Map()
	}

	async _resetWebSocket() {
		while (this._httpQueue.length) {
			const item = this._httpQueue.shift()
			try {
				clearTimeout(item?.timer)
			} catch {}
			item?.reject?.(new Error('WebSocket closed'))
		}

		if (this.ws) {
			try {
				this.ws.close(1000)
			} catch {}
			this.ws = null
		}
	}

	maybeReconnect() {
		if (this.isInitialized && this.config.reconnect) {
			if (this.reconnect_timer) clearTimeout(this.reconnect_timer)
			this.reconnect_timer = setTimeout(() => {
				this.connectWebSocket().catch((e) => {
					this.log('error', `Reconnect failed: ${e}`)
					this.maybeReconnect()
				})
			}, 5000)
		}
	}

	async connectWebSocket() {
		if (!this.config.ip || !this.config.port) {
			this.log('info', 'IP or Port not defined')
			this.updateStatus(InstanceStatus.BadConfig, `IP or Port not defined`)
			return
		}
		const url = `ws://${this.config.ip}:${this.config.port}`
		this.log('info', `Connecting to WebSocket: ${url}`)
		this.updateStatus(InstanceStatus.Connecting)
		this.ws = new WebSocket(url)

		this.ws.on('open', async () => {
			this.log('info', 'WebSocket connection opened')
			this.updateStatus(InstanceStatus.Ok)
			this.updateVariables()
			try {
				await this.fetchPresets()
				await this.refreshCatalogs()
				await this.ensurePresetSubscriptions()
			} catch (e) {
				this.log('error', `Post-open setup failed: ${e?.message || e}`)
			}
		})

		this.ws.on('close', (code) => {
			this.log('warning', `Connection closed with code ${code}`)
			this.updateStatus(InstanceStatus.Disconnected, `Connection closed with code ${code}`)
			this.maybeReconnect()
		})

		this.ws.on('error', (err) => {
			this.log('error', `WebSocket error: ${err?.message || err}`)
		})

		this.ws.on('message', (data) => this._onWsMessage(data))

		await new Promise((resolve, reject) => {
			const onOpen = () => { cleanup(); resolve() }
			const onErr = (e) => { cleanup(); reject(e) }
			const cleanup = () => {
				this.ws?.off?.('open', onOpen)
				this.ws?.off?.('error', onErr)
			}
			this.ws.once('open', onOpen)
			this.ws.once('error', onErr)
			setTimeout(() => { cleanup(); reject(new Error('WebSocket connect timeout')) }, 5000)
		})
	}

	async _sendWsHttp(url, verb = 'GET', body = undefined, timeoutMs = 8000) {
		if (!this.ws || this.ws.readyState !== 1) throw new Error('WebSocket not open')

		if (this._httpQueue.length) {
			await this._httpQueue[this._httpQueue.length - 1].promise.catch(() => {})
		}

		const payload = { MessageName: 'http', Parameters: { Url: url, Verb: verb } }
		if (body !== undefined) payload.Parameters.Body = body

		let extResolve, extReject
		const p = new Promise((resolve, reject) => {
			extResolve = resolve
			extReject = reject
		})
		const timer = setTimeout(() => {
			const item = this._httpQueue.shift()
			item?.reject?.(new Error(`WS HTTP timeout for ${verb} ${url}`))
		}, timeoutMs)

		this._httpQueue.push({ resolve: extResolve, reject: extReject, timer, promise: p })

		if (this.config.debug_messages) this.log('debug', `WS->HTTP ${verb} ${url} ${body ? JSON.stringify(body) : ''}`)
		this.ws.send(JSON.stringify(payload), (err) => {
			if (err) {
				const item = this._httpQueue.shift()
				try {
					clearTimeout(item?.timer)
				} catch {}
				item?.reject?.(err)
			}
		})

		return await p
	}

	_kickAllFeedbacks() {
		try {
			this.checkFeedbacks?.('boolean_property_value')
			this.checkFeedbacks?.('float_threshold')
			this.checkFeedbacks?.('int_threshold')
			this.checkFeedbacks?.('string_equals')
			this.checkFeedbacks?.('text_equals')
			this.checkFeedbacks?.('name_equals')
			this.checkFeedbacks?.('enum_equals')
		} catch (e) {
			this.log('debug', `_kickAllFeedbacks error: ${e?.message || e}`)
		}
	}

	_scheduleFeedbackKickDebounced(delay = 60) {
		try {
			if (this.__kickTimer) clearTimeout(this.__kickTimer)
			this.__kickTimer = setTimeout(() => {
				this.__kickTimer = null
				this._kickAllFeedbacks()
			}, delay)
		} catch {}
	}

	_startFeedbackPolling() {
		this._stopFeedbackPolling()
		if (this.config?.feedback_polling) {
			const ms = Math.max(250, Number(this.config?.feedback_poll_ms || 1000))
			this.__pollTimer = setInterval(() => this._kickAllFeedbacks(), ms)
			this.log('info', `Feedback polling enabled (${ms} ms)`)
		} else {
			this.log('info', `Feedback polling disabled`)
		}
	}

	_stopFeedbackPolling() {
		if (this.__pollTimer) {
			clearInterval(this.__pollTimer)
			this.__pollTimer = null
		}
	}

	_onWsMessage(frame) {
		try {
			if (frame instanceof Buffer) frame = frame.toString()
			const msg = typeof frame === 'string' ? JSON.parse(frame) : frame

			if (msg && typeof msg === 'object' && 'ResponseCode' in msg && 'ResponseBody' in msg) {
				const item = this._httpQueue.shift()
				try {
					clearTimeout(item?.timer)
				} catch {}
				item?.resolve?.(msg)
				this._scheduleFeedbackKickDebounced()
				return
			}

			if (msg && typeof msg === 'object' && msg.Type) {
				if (msg.Type === 'PresetFieldsChanged' && msg.PresetName) {
					const preset = msg.PresetName
					for (const field of msg.ChangedFields || []) {
						const label = field?.PropertyLabel
						const value = field?.PropertyValue
						if (!label) continue
						if (
							this.boolChoices.some((c) => {
								try {
									const p = JSON.parse(c.id)
									return p.preset === preset && p.property === label
								} catch {
									return false
								}
							})
						) {
							const b = !!value
							if (!this.lastBoolValues.has(preset)) this.lastBoolValues.set(preset, new Map())
							this.lastBoolValues.get(preset).set(label, b)
						}
					}
					this.checkFeedbacks?.('boolean_property_value')
					this.checkFeedbacks?.('float_threshold')
					this.checkFeedbacks?.('int_threshold')
					this.checkFeedbacks?.('string_equals')
					this.checkFeedbacks?.('text_equals')
					this.checkFeedbacks?.('name_equals')
					this.checkFeedbacks?.('enum_equals')
				} else if (
					msg.Type === 'PresetFieldsAdded' ||
					msg.Type === 'PresetFieldsRemoved' ||
					msg.Type === 'PresetFieldsRenamed'
				) {
					clearTimeout(this._catalogRefreshTimer)
					this._catalogRefreshTimer = setTimeout(() => {
						this.refreshCatalogs().catch((e) => this.log('error', `Catalog refresh error: ${e?.message || e}`))
					}, 200)
				}
				this._scheduleFeedbackKickDebounced()
			}

			this.subscriptions.forEach((subscription) => {
				const path = `${subscription.subpath}`
				if (!subscription.variableName) return
				if (subscription.subpath === '') {
					this.setVariableValues({ [subscription.variableName]: typeof msg === 'object' ? JSON.stringify(msg) : msg })
				} else if (typeof msg === 'object' && objectPath.has(msg, path)) {
					const value = objectPath.get(msg, path)
					this.setVariableValues({
						[subscription.variableName]: typeof value === 'object' ? JSON.stringify(value) : value,
					})
				}
			})
			this.setVariableValues({ lastDataReceived: Date.now() })
		} catch (e) {
			if (this.config.debug_messages) this.log('debug', `onMessage parse error: ${e?.message || e}`)
		}
	}

	async fetchPresets() {
		this.presets = []
		if (!this.ws || this.ws.readyState !== 1) return
		try {
			const res = await this._sendWsHttp('/remote/presets', 'GET')
			const arr = res?.ResponseBody?.Presets || []
			this.presets = arr.map((p) => p.Name)
			this.log('info', `Presets: ${JSON.stringify(this.presets)}`)
		} catch (e) {
			this.log('error', `Preset fetch failed: ${e?.message || e}`)
		}
	}

	async refreshCatalogs() {
		this.boolChoices = []
		this.floatChoices = []
		this.intChoices = []
		this.stringChoices = []
		this.textChoices = []
		this.nameChoices = []
		this.enumPropChoices = []
		this.functions = []

		for (const preset of this.presets) {
			try {
				const enc = encodeURIComponent(preset)
				const res = await this._sendWsHttp(`/remote/preset/${enc}`, 'GET')
				const groups = res?.ResponseBody?.Preset?.Groups || []

				for (const g of groups) {
					const props = g?.ExposedProperties || []
					for (const prop of props) {
						const label = prop?.DisplayName
						const tyRaw = String(prop?.UnderlyingProperty?.Type ?? '').toLowerCase()
						if (!label || !tyRaw) continue

						if (tyRaw === 'bool' || tyRaw === 'boolproperty') {
							this.boolChoices.push({ id: JSON.stringify({ preset, property: label }), label: `${preset} • ${label}` })
						} else if (tyRaw === 'float' || tyRaw === 'double' || tyRaw.endsWith('floatproperty') || tyRaw.endsWith('doubleproperty')) {
							this.floatChoices.push({ id: JSON.stringify({ preset, property: label }), label: `${preset} • ${label}` })
						} else if (tyRaw.startsWith('int') || tyRaw === 'byte' || tyRaw.endsWith('intproperty') || tyRaw === 'byteproperty') {
							this.intChoices.push({ id: JSON.stringify({ preset, property: label }), label: `${preset} • ${label}` })
						} else if (tyRaw === 'fstring' || tyRaw === 'str' || tyRaw === 'string' || tyRaw === 'strproperty') {
							this.stringChoices.push({ id: JSON.stringify({ preset, property: label }), label: `${preset} • ${label}` })
						} else if (tyRaw === 'ftext' || tyRaw === 'text' || tyRaw === 'textproperty') {
							this.textChoices.push({ id: JSON.stringify({ preset, property: label }), label: `${preset} • ${label}` })
						} else if (tyRaw === 'fname' || tyRaw === 'name' || tyRaw === 'nameproperty') {
							this.nameChoices.push({ id: JSON.stringify({ preset, property: label }), label: `${preset} • ${label}` })
						} else if (tyRaw.includes('enum') || /<e[a-z0-9_:+-]+>/.test(tyRaw) || /^e[a-z0-9_:+-]+/.test(tyRaw)) {
							this.enumPropChoices.push({ id: JSON.stringify({ preset, property: label }), label: `${preset} • ${label}` })
						}
					}

					const funcs = g?.ExposedFunctions || []
					for (const fn of funcs) {
						const label = fn?.DisplayName
						if (!label) continue
						const argsRaw = fn?.UnderlyingFunction?.Arguments || []
						const args = argsRaw.map((a) => this._mapArgDescriptor(a))
						this.functions.push({ preset, label, args })
					}
				}
			} catch (e) {
				this.log('error', `Error reading preset ${preset}: ${e?.message || e}`)
			}
		}

		await initActions(this)
		initFeedbacks(this)
		await this.ensurePresetSubscriptions()
	}

	_mapArgDescriptor(a) {
		const typeRaw = String(a?.Type || '').trim()
		const type = typeRaw.toLowerCase()
		let kind = 'json'
		if (type === 'bool') kind = 'bool'
		else if (type === 'float' || type === 'double') kind = 'float'
		else if (type.startsWith('int') || type === 'byte' || type === 'uint8' || type.endsWith('int')) kind = 'int'
		else if (type === 'fstring' || type === 'string' || type === 'str') kind = 'string'
		else if (type === 'ftext' || type === 'text') kind = 'text'
		else if (type === 'fname' || type === 'name') kind = 'name'
		else if (type.includes('enum') || /^e[a-z0-9_:+]+/i.test(typeRaw) || /<e[a-z0-9_:+]+>/i.test(typeRaw)) kind = 'enum'
		return { name: a?.Name || 'Arg', type: typeRaw, kind, enumChoices: undefined }
	}

	async ensurePresetSubscriptions() {
		for (const preset of this.presets) await this._registerPreset(preset)
	}

	async _registerPreset(preset) {
		if (!this.ws || this.ws.readyState !== 1 || !preset) return
		const payload = { MessageName: 'preset.register', Parameters: { PresetName: preset } }
		this.ws.send(JSON.stringify(payload))
	}

	async _getValueViaPreset(preset, property) {
		if (!this.ws || this.ws.readyState !== 1 || !preset || !property) return null
		try {
			const encP = encodeURIComponent(preset)
			const encProp = encodeURIComponent(property)
			const res = await this._sendWsHttp(`/remote/preset/${encP}/property/${encProp}`, 'GET')
			const arr = res?.ResponseBody?.PropertyValues || []
			return arr[0]?.PropertyValue ?? null
		} catch (e) {
			if (this.config?.debug_messages) this.log('debug', `_getValueViaPreset error: ${e?.message || e}`)
			return null
		}
	}

	async _setPropertyViaPreset(preset, property, value) {
		if (!this.ws || this.ws.readyState !== 1) return false
		const encP = encodeURIComponent(preset)
		const encProp = encodeURIComponent(property)
		try {
			const res = await this._sendWsHttp(
				`/remote/preset/${encP}/property/${encProp}`,
				'PUT',
				{ PropertyValue: value, GenerateTransaction: true },
				10000,
			)
			return res?.ResponseCode === 200
		} catch (e) {
			this.log('error', `Set property failed: ${e?.message || e}`)
			return false
		}
	}

	updateVariables(callerId = null) {
		const variables = new Set()
		const defaultValues = {}
		this.subscriptions.forEach((subscription, subscriptionId) => {
			if (!subscription.variableName?.match(/^[-a-zA-Z0-9_]+$/)) return
			variables.add(subscription.variableName)
			if (callerId === null || callerId === subscriptionId) defaultValues[subscription.variableName] = ''
		})
		const variableDefinitions = [{ name: 'Timestamp when last data was received', variableId: 'lastDataReceived' }]
		variables.forEach((variable) => variableDefinitions.push({ name: variable, variableId: variable }))
		this.setVariableDefinitions(variableDefinitions)
		this.setVariableValues(defaultValues)
	}

	_slug(s) {
		return String(s)
			.replace(/[^a-z0-9]+/gi, '_')
			.replace(/^_+|_+$/g, '')
			.toLowerCase()
			.slice(0, 100)
	}

	async testPing() {
		if (!this.ws || this.ws.readyState !== 1) return
		const pingMsg = { jsonrpc: '2.0', method: 'rc.ping', id: 'testping' }
		this.log('info', `Sending rc.ping (for logs): ${JSON.stringify(pingMsg)}`)
		this.ws.send(JSON.stringify(pingMsg))
	}
}

runEntrypoint(WebsocketInstance, upgradeScripts)
