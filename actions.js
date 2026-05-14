export async function initActions(instance) {
	const defs = {
		send_command: {
			name: 'Send raw WebSocket message',
			options: [{ type: 'textinput', label: 'data', id: 'data', default: '', useVariables: true }],
			callback: async (action, context) => {
				if (!instance.ws || instance.ws.readyState !== 1) throw new Error('WebSocket not connected')
				const value = await context.parseVariablesInString(action.options.data ?? '')
				return new Promise((resolve, reject) => {
					instance.ws.send(`${value}`, (err) => (err ? reject(err) : resolve()))
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
					default: instance.boolChoices?.[0]?.id || '',
					choices: instance.boolChoices || [],
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
				if (mode === 'true') {
					await instance._setPropertyViaPreset(preset, property, true)
				} else if (mode === 'false') {
					await instance._setPropertyViaPreset(preset, property, false)
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
					default: instance.floatChoices?.[0]?.id || '',
					choices: instance.floatChoices || [],
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
				await instance._setPropertyViaPreset(preset, property, Number(s))
			},
		},

		set_integer_property: {
			name: 'Set Integer',
			options: [
				{
					type: 'dropdown',
					id: 'int_select',
					label: 'Preset • Integer Property',
					default: instance.intChoices?.[0]?.id || '',
					choices: instance.intChoices || [],
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
				await instance._setPropertyViaPreset(preset, property, Math.trunc(Number(s)))
			},
		},

		set_string_property: {
			name: 'Set String (FString)',
			options: [
				{
					type: 'dropdown',
					id: 'str_select',
					label: 'Preset • FString Property',
					default: instance.stringChoices?.[0]?.id || '',
					choices: instance.stringChoices || [],
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
				await instance._setPropertyViaPreset(preset, property, String(s))
			},
		},

		set_text_property: {
			name: 'Set Text (FText)',
			options: [
				{
					type: 'dropdown',
					id: 'text_select',
					label: 'Preset • FText Property',
					default: instance.textChoices?.[0]?.id || '',
					choices: instance.textChoices || [],
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

				let ok = await instance._setPropertyViaPreset(preset, property, val)
				if (!ok) ok = await instance._setPropertyViaPreset(preset, property, { Text: val })
				if (!ok) ok = await instance._setPropertyViaPreset(preset, property, { SourceString: val })
			},
		},

		set_name_property: {
			name: 'Set Name (FName)',
			options: [
				{
					type: 'dropdown',
					id: 'name_select',
					label: 'Preset • FName Property',
					default: instance.nameChoices?.[0]?.id || '',
					choices: instance.nameChoices || [],
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
				await instance._setPropertyViaPreset(preset, property, String(s))
			},
		},

		set_enum_property: {
			name: 'Set Enum',
			options: [
				{
					type: 'dropdown',
					id: 'enum_prop_select',
					label: 'Preset • Enum Property',
					default: instance.enumPropChoices?.[0]?.id || '',
					choices: instance.enumPropChoices || [],
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
				await instance._setPropertyViaPreset(preset, property, val)
			},
		},
	}

	for (const fn of instance.functions) {
		const actionId = instance._slug(`callfn__${fn.preset}__${fn.label}`)
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
		// Name uses `${preset}: ${label}` so Companion's alphabetical ordering naturally groups
		// actions of the same preset — Companion has no real category support for actions, so
		// a sortable prefix is the closest to grouping we can get in the UI.
		const argSummary = fn.args.length > 0 ? fn.args.map((a) => a.name).join(', ') : 'none'
		defs[actionId] = {
			name: `${fn.preset}: ${fn.label}`,
			description: `Call function "${fn.label}" on preset "${fn.preset}". Args: ${argSummary}.`,
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
				const res = await instance._sendWsHttp(`/remote/preset/${encP}/function/${encF}`, 'PUT', body, 15000)

				if (res?.ResponseCode !== 200) {
					let retried = false
					for (const arg of fn.args) {
						if (arg.kind === 'text' && typeof parameters[arg.name] === 'string') {
							parameters[arg.name] = { Text: parameters[arg.name] }
							retried = true
						}
					}
					if (retried) {
						await instance._sendWsHttp(
							`/remote/preset/${encP}/function/${encF}`,
							'PUT',
							{ Parameters: parameters, GenerateTransaction: true },
							15000,
						)
					}
				}

				// Keep cache maintenance only; feedback polling/checks are disabled.
				instance.lastBoolValues.clear()
			},
		}
	}

	instance.setActionDefinitions(defs)
}
