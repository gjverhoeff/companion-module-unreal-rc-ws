import { InstanceBase, runEntrypoint, InstanceStatus } from '@companion-module/base'
import WebSocket from 'ws'
import objectPath from 'object-path'
import { upgradeScripts } from './upgrade.js'

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
		await this.initActions()
		this.initFeedbacks()
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
					await this.initActions()
					this.initFeedbacks()
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

		await this.initActions()
		this.initFeedbacks()
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

	async initActions() {
		const defs = {
			send_command: {
				name: 'Send raw WebSocket message',
				options: [{ type: 'textinput', label: 'data', id: 'data', default: '', useVariables: true }],
				callback: async (action, context) => {
					if (!this.ws || this.ws.readyState !== 1) throw new Error('WebSocket not connected')
					const value = await context.parseVariablesInString(action.options.data ?? '')
					return new Promise((resolve, reject) => {
						this.ws.send(`${value}`, (err) => (err ? reject(err) : resolve()))
					})
				},
			},

			set_boolean_property: {
				name: 'Set Boolean',
				options: [
					{
						type: 'dropdown',
						id: 'bool_select',
						label: 'Preset • Boolean Property',
						default: this.boolChoices?.[0]?.id || '',
						choices: this.boolChoices || [],
						minChoicesForSearch: 1,
					},
					{
						type: 'dropdown',
						id: 'value',
						label: 'Value',
						default: 'true',
						choices: [
							{ id: 'true', label: 'True' },
							{ id: 'false', label: 'False' },
							{ id: 'toggle', label: 'Toggle' },
						],
						minChoicesForSearch: 1,
					},
				],
				callback: async (action) => {
					let parsed
					try {
						parsed = JSON.parse(action.options.bool_select || '{}')
					} catch {}
					const preset = parsed?.preset
					const property = parsed?.property
					if (!preset || !property) return

					const mode = action.options.value
					if (mode === 'toggle') {
						const current = !!(await this._getValueViaPreset(preset, property))
						await this._setPropertyViaPreset(preset, property, !current)
					} else if (mode === 'true') {
						await this._setPropertyViaPreset(preset, property, true)
					} else if (mode === 'false') {
						await this._setPropertyViaPreset(preset, property, false)
					}
				},
			},

			set_float_property: {
				name: 'Set Float',
				options: [
					{
						type: 'dropdown',
						id: 'float_select',
						label: 'Preset • Float Property',
						default: this.floatChoices?.[0]?.id || '',
						choices: this.floatChoices || [],
						minChoicesForSearch: 1,
					},
					{ type: 'textinput', id: 'value', label: 'Value (float)', default: '0', useVariables: true },
				],
				callback: async (action, context) => {
					let parsed
					try {
						parsed = JSON.parse(action.options.float_select || '{}')
					} catch {}
					const preset = parsed?.preset
					const property = parsed?.property
					if (!preset || !property) return
					const s = await context.parseVariablesInString(action.options.value ?? '0')
					await this._setPropertyViaPreset(preset, property, Number(s))
				},
			},

			set_integer_property: {
				name: 'Set Integer',
				options: [
					{
						type: 'dropdown',
						id: 'int_select',
						label: 'Preset • Integer Property',
						default: this.intChoices?.[0]?.id || '',
						choices: this.intChoices || [],
						minChoicesForSearch: 1,
					},
					{ type: 'textinput', id: 'value', label: 'Value (int)', default: '0', useVariables: true },
				],
				callback: async (action, context) => {
					let parsed
					try {
						parsed = JSON.parse(action.options.int_select || '{}')
					} catch {}
					const preset = parsed?.preset
					const property = parsed?.property
					if (!preset || !property) return
					const s = await context.parseVariablesInString(action.options.value ?? '0')
					await this._setPropertyViaPreset(preset, property, Math.trunc(Number(s)))
				},
			},

			set_string_property: {
				name: 'Set String (FString)',
				options: [
					{
						type: 'dropdown',
						id: 'str_select',
						label: 'Preset • FString Property',
						default: this.stringChoices?.[0]?.id || '',
						choices: this.stringChoices || [],
						minChoicesForSearch: 1,
					},
					{ type: 'textinput', id: 'value', label: 'String value', default: '', useVariables: true },
				],
				callback: async (action, context) => {
					let parsed
					try {
						parsed = JSON.parse(action.options.str_select || '{}')
					} catch {}
					const preset = parsed?.preset
					const property = parsed?.property
					if (!preset || !property) return
					const s = await context.parseVariablesInString(action.options.value ?? '')
					await this._setPropertyViaPreset(preset, property, String(s))
				},
			},

			set_text_property: {
				name: 'Set Text (FText)',
				options: [
					{
						type: 'dropdown',
						id: 'text_select',
						label: 'Preset • FText Property',
						default: this.textChoices?.[0]?.id || '',
						choices: this.textChoices || [],
						minChoicesForSearch: 1,
					},
					{ type: 'textinput', id: 'value', label: 'Text', default: '', useVariables: true },
				],
				callback: async (action, context) => {
					let parsed
					try {
						parsed = JSON.parse(action.options.text_select || '{}')
					} catch {}
					const preset = parsed?.preset
					const property = parsed?.property
					if (!preset || !property) return
					const val = String(await context.parseVariablesInString(action.options.value ?? ''))

					let ok = await this._setPropertyViaPreset(preset, property, val)
					if (!ok) ok = await this._setPropertyViaPreset(preset, property, { Text: val })
					if (!ok) ok = await this._setPropertyViaPreset(preset, property, { SourceString: val })
				},
			},

			set_name_property: {
				name: 'Set Name (FName)',
				options: [
					{
						type: 'dropdown',
						id: 'name_select',
						label: 'Preset • FName Property',
						default: this.nameChoices?.[0]?.id || '',
						choices: this.nameChoices || [],
						minChoicesForSearch: 1,
					},
					{ type: 'textinput', id: 'value', label: 'Name', default: '', useVariables: true },
				],
				callback: async (action, context) => {
					let parsed
					try {
						parsed = JSON.parse(action.options.name_select || '{}')
					} catch {}
					const preset = parsed?.preset
					const property = parsed?.property
					if (!preset || !property) return
					const s = await context.parseVariablesInString(action.options.value ?? '')
					await this._setPropertyViaPreset(preset, property, String(s))
				},
			},

			set_enum_property: {
				name: 'Set Enum',
				options: [
					{
						type: 'dropdown',
						id: 'enum_prop_select',
						label: 'Preset • Enum Property',
						default: this.enumPropChoices?.[0]?.id || '',
						choices: this.enumPropChoices || [],
						minChoicesForSearch: 1,
					},
					{
						type: 'textinput',
						id: 'enum_value',
						label: 'Enum Value (text; UE will match)',
						default: '',
						useVariables: true,
					},
				],
				callback: async (action, context) => {
					let p1
					try {
						p1 = JSON.parse(action.options.enum_prop_select || '{}')
					} catch {}
					const preset = p1?.preset
					const property = p1?.property
					if (!preset || !property) return
					const val = String(await context.parseVariablesInString(action.options.enum_value ?? ''))

					await this._setPropertyViaPreset(preset, property, val)
				},
			},
		}

		for (const fn of this.functions) {
			const actionId = this._slug(`callfn__${fn.preset}__${fn.label}`)
			const options = []

			for (const arg of fn.args) {
				options.push({
					type: 'textinput',
					id: arg.name,
					label: `${arg.name} (${arg.kind || arg.type})`,
					default: '',
					useVariables: true,
				})
			}

			defs[actionId] = {
				name: `Call Function • ${fn.preset} • ${fn.label}`,
				options,
				callback: async (action, context) => {
					const parameters = {}
					for (const arg of fn.args) {
						const rawStr = await context.parseVariablesInString(action.options[arg.name] ?? '')
						const s = String(rawStr)
						switch (arg.kind) {
							case 'bool': {
								const l = s.trim().toLowerCase()
								parameters[arg.name] = ['true', '1', 'on', 'yes'].includes(l)
								break
							}
							case 'float':
								parameters[arg.name] = Number(s)
								break
							case 'int':
								parameters[arg.name] = Math.trunc(Number(s))
								break
							case 'string':
								parameters[arg.name] = s
								break
							case 'text':
								parameters[arg.name] = s
								break
							case 'name':
								parameters[arg.name] = s
								break
							case 'enum':
								parameters[arg.name] = s
								break
							default:
								try {
									parameters[arg.name] = s.trim().startsWith('{') || s.trim().startsWith('[') ? JSON.parse(s) : s
								} catch {
									parameters[arg.name] = s
								}
						}
					}

					const encP = encodeURIComponent(fn.preset)
					const encF = encodeURIComponent(fn.label)
					const body = { Parameters: parameters, GenerateTransaction: true }
					const res = await this._sendWsHttp(`/remote/preset/${encP}/function/${encF}`, 'PUT', body, 15000)

					if (res?.ResponseCode !== 200) {
						let retried = false
						for (const arg of fn.args) {
							if (arg.kind === 'text' && typeof parameters[arg.name] === 'string') {
								parameters[arg.name] = { Text: parameters[arg.name] }
								retried = true
							}
						}
						if (retried) {
							await this._sendWsHttp(
								`/remote/preset/${encP}/function/${encF}`,
								'PUT',
								{ Parameters: parameters, GenerateTransaction: true },
								15000,
							)
						}
					}
				},
			}
		}

		this.setActionDefinitions(defs)
	}

	_slug(s) {
		return String(s)
			.replace(/[^a-z0-9]+/gi, '_')
			.replace(/^_+|_+$/g, '')
			.toLowerCase()
			.slice(0, 100)
	}

	initFeedbacks() {
		this.setFeedbackDefinitions({
			boolean_property_value: {
				type: 'boolean',
				name: 'Boolean equals',
				description: '',
				options: [
					{
						type: 'dropdown',
						id: 'bool_select',
						label: 'Preset • Boolean Property',
						default: this.boolChoices?.[0]?.id || '',
						choices: this.boolChoices || [],
						minChoicesForSearch: 1,
					},
					{
						type: 'dropdown',
						id: 'mode',
						label: 'When to apply style',
						default: 'true',
						choices: [
							{ id: 'true', label: 'When TRUE' },
							{ id: 'false', label: 'When FALSE' },
							{ id: 'toggle', label: 'Toggle (invert)' },
						],
						minChoicesForSearch: 1,
					},
				],
				defaultStyle: { bgcolor: 0x00aa00, color: 0xffffff },
				callback: async (feedback) => {
					const sel = feedback.options.bool_select
					if (!sel) return false
					let parsed
					try {
						parsed = JSON.parse(sel)
					} catch {}
					const preset = parsed?.preset
					const property = parsed?.property
					const mode = feedback.options.mode || 'true'
					const cached = this.lastBoolValues.get(preset)?.get(property)
					const v = typeof cached === 'boolean' ? cached : !!(await this._getValueViaPreset(preset, property))
					if (mode === 'true') return v
					return !v
				},
			},

			enum_equals: {
				type: 'boolean',
				name: 'Enum equals',
				description: '',
				options: [
					{
						type: 'dropdown',
						id: 'enum_select',
						label: 'Preset • Enum Property',
						default: this.enumPropChoices?.[0]?.id || '',
						choices: this.enumPropChoices || [],
						minChoicesForSearch: 1,
					},
					{
						type: 'textinput',
						id: 'value',
						label: 'Equals… (string)',
						default: '',
					},
				],
				defaultStyle: { bgcolor: 0xaa6600, color: 0xffffff },
				callback: async (fb) => {
					let parsed
					try {
						parsed = JSON.parse(fb.options.enum_select || '{}')
					} catch {}
					const preset = parsed?.preset
					const property = parsed?.property
					if (!preset || !property) return false
					const v = await this._getValueViaPreset(preset, property)
					const current =
						typeof v === 'object' ? (v?.ValueName ?? v?.Name ?? v?.DisplayName ?? v?.Value ?? '') : (v ?? '')
					return String(current) === String(fb.options.value ?? '')
				},
			},

			float_threshold: {
				type: 'boolean',
				name: 'Float Threshold',
				description: '',
				options: [
					{
						type: 'dropdown',
						id: 'float_select',
						label: 'Preset • Float Property',
						default: this.floatChoices?.[0]?.id || '',
						choices: this.floatChoices || [],
						minChoicesForSearch: 1,
					},
					{ type: 'number', id: 'threshold', label: 'Threshold', default: 0 },
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Condition',
						default: 'gt',
						choices: [
							{ id: 'gt', label: '>' },
							{ id: 'lt', label: '<' },
							{ id: 'ge', label: '>=' },
							{ id: 'le', label: '<=' },
							{ id: 'eq', label: '=' },
						],
						minChoicesForSearch: 1,
					},
					{ type: 'number', id: 'epsilon', label: 'Epsilon (= only)', default: 0.0001 },
				],
				defaultStyle: { bgcolor: 0x0066aa, color: 0xffffff },
				callback: async (feedback) => {
					let parsed
					try {
						parsed = JSON.parse(feedback.options.float_select || '{}')
					} catch {}
					const preset = parsed?.preset
					const property = parsed?.property
					const val = Number(await this._getValueViaPreset(preset, property))
					const thr = Number(feedback.options.threshold)
					const eps = Number(feedback.options.epsilon)
					switch (feedback.options.mode) {
						case 'gt':
							return val > thr
						case 'lt':
							return val < thr
						case 'ge':
							return val >= thr
						case 'le':
							return val <= thr
						case 'eq':
							return Math.abs(val - thr) <= eps
						default:
							return false
					}
				},
			},

			int_threshold: {
				type: 'boolean',
				name: 'Integer Threshold',
				description: '',
				options: [
					{
						type: 'dropdown',
						id: 'int_select',
						label: 'Preset • Integer Property',
						default: this.intChoices?.[0]?.id || '',
						choices: this.intChoices || [],
						minChoicesForSearch: 1,
					},
					{ type: 'number', id: 'threshold', label: 'Threshold (int)', default: 0 },
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Condition',
						default: 'gt',
						choices: [
							{ id: 'gt', label: '>' },
							{ id: 'lt', label: '<' },
							{ id: 'ge', label: '>=' },
							{ id: 'le', label: '<=' },
							{ id: 'eq', label: '=' },
						],
						minChoicesForSearch: 1,
					},
				],
				defaultStyle: { bgcolor: 0x4444aa, color: 0xffffff },
				callback: async (feedback) => {
					let parsed
					try {
						parsed = JSON.parse(feedback.options.int_select || '{}')
					} catch {}
					const preset = parsed?.preset
					const property = parsed?.property
					const val = Math.trunc(Number(await this._getValueViaPreset(preset, property)))
					const thr = Math.trunc(Number(feedback.options.threshold))
					switch (feedback.options.mode) {
						case 'gt':
							return val > thr
						case 'lt':
							return val < thr
						case 'ge':
							return val >= thr
						case 'le':
							return val <= thr
						case 'eq':
							return val === thr
						default:
							return false
					}
				},
			},

			string_equals: {
				type: 'boolean',
				name: 'String equals (FString)',
				description: '',
				options: [
					{
						type: 'dropdown',
						id: 'str_select',
						label: 'Preset • FString Property',
						default: this.stringChoices?.[0]?.id || '',
						choices: this.stringChoices || [],
						minChoicesForSearch: 1,
					},
					{ type: 'textinput', id: 'value', label: 'Equals…', default: '' },
				],
				defaultStyle: { bgcolor: 0x008866, color: 0xffffff },
				callback: async (fb) => {
					let parsed
					try {
						parsed = JSON.parse(fb.options.str_select || '{}')
					} catch {}
					const preset = parsed?.preset
					const property = parsed?.property
					const v = await this._getValueViaPreset(preset, property)
					return String(v ?? '') === String(fb.options.value ?? '')
				},
			},

			text_equals: {
				type: 'boolean',
				name: 'Text equals (FText)',
				description: '',
				options: [
					{
						type: 'dropdown',
						id: 'text_select',
						label: 'Preset • FText Property',
						default: this.textChoices?.[0]?.id || '',
						choices: this.textChoices || [],
						minChoicesForSearch: 1,
					},
					{ type: 'textinput', id: 'value', label: 'Equals…', default: '' },
				],
				defaultStyle: { bgcolor: 0x885500, color: 0xffffff },
				callback: async (fb) => {
					let parsed
					try {
						parsed = JSON.parse(fb.options.text_select || '{}')
					} catch {}
					const preset = parsed?.preset
					const property = parsed?.property
					const v = await this._getValueViaPreset(preset, property)
					const str = typeof v === 'object' ? (v?.Text ?? v?.SourceString ?? v?.Value ?? '') : v
					return String(str ?? '') === String(fb.options.value ?? '')
				},
			},

			name_equals: {
				type: 'boolean',
				name: 'Name equals (FName)',
				description: '',
				options: [
					{
						type: 'dropdown',
						id: 'name_select',
						label: 'Preset • FName Property',
						default: this.nameChoices?.[0]?.id || '',
						choices: this.nameChoices || [],
						minChoicesForSearch: 1,
					},
					{ type: 'textinput', id: 'value', label: 'Equals…', default: '' },
				],
				defaultStyle: { bgcolor: 0x2266aa, color: 0xffffff },
				callback: async (fb) => {
					let parsed
					try {
						parsed = JSON.parse(fb.options.name_select || '{}')
					} catch {}
					const preset = parsed?.preset
					const property = parsed?.property
					const v = await this._getValueViaPreset(preset, property)
					return String(v ?? '') === String(fb.options.value ?? '')
				},
			},
		})
	}

	async testPing() {
		if (!this.ws || this.ws.readyState !== 1) return
		const pingMsg = { jsonrpc: '2.0', method: 'rc.ping', id: 'testping' }
		this.log('info', `Sending rc.ping (for logs): ${JSON.stringify(pingMsg)}`)
		this.ws.send(JSON.stringify(pingMsg))
	}
}

runEntrypoint(WebsocketInstance, upgradeScripts)
