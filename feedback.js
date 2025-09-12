export function initFeedbacks(instance) {
	instance.setFeedbackDefinitions({
		boolean_property_value: {
			type: 'boolean',
			name: 'Boolean equals',
			description: '',
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
				const cached = instance.lastBoolValues.get(preset)?.get(property)
				const v = typeof cached === 'boolean' ? cached : !!(await instance._getValueViaPreset(preset, property))
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
					default: instance.enumPropChoices?.[0]?.id || '',
					choices: instance.enumPropChoices || [],
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
				const v = await instance._getValueViaPreset(preset, property)
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
					default: instance.floatChoices?.[0]?.id || '',
					choices: instance.floatChoices || [],
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
				const val = Number(await instance._getValueViaPreset(preset, property))
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
					default: instance.intChoices?.[0]?.id || '',
					choices: instance.intChoices || [],
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
				const val = Math.trunc(Number(await instance._getValueViaPreset(preset, property)))
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
					default: instance.stringChoices?.[0]?.id || '',
					choices: instance.stringChoices || [],
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
				const v = await instance._getValueViaPreset(preset, property)
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
					default: instance.textChoices?.[0]?.id || '',
					choices: instance.textChoices || [],
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
				const v = await instance._getValueViaPreset(preset, property)
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
					default: instance.nameChoices?.[0]?.id || '',
					choices: instance.nameChoices || [],
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
				const v = await instance._getValueViaPreset(preset, property)
				return String(v ?? '') === String(fb.options.value ?? '')
			},
		},
	})
}
