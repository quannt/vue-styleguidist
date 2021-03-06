import * as path from 'path'
import filter from 'lodash/filter'
import map from 'lodash/map'
import values from 'lodash/values'
import flatten from 'lodash/flatten'
import loaderUtils from 'loader-utils'
import { generate } from 'escodegen'
import toAst from 'to-ast'
import { builders as b } from 'ast-types'
import { parse } from 'vue-docgen-api'
import { compile } from 'vue-inbrowser-compiler'
import chunkify from 'react-styleguidist/lib/loaders/utils/chunkify'
import getImports from 'react-styleguidist/lib/loaders/utils/getImports'
import requireIt from 'react-styleguidist/lib/loaders/utils/requireIt'
import resolveESModule from 'react-styleguidist/lib/loaders/utils/resolveESModule'
import { StyleguidistContext } from '../types/StyleGuide'
import { ExampleLoader } from '../types/Example'
import expandDefaultComponent from './utils/expandDefaultComponent'
import getComponentVueDoc from './utils/getComponentVueDoc'
import importCodeExampleFile from './utils/importCodeExampleFile'
import absolutize from './utils/absolutize'
import getScript from './utils/getScript'

const REQUIRE_IN_RUNTIME_PATH = absolutize('requireInRuntime')
const EVAL_IN_CONTEXT_PATH = absolutize('evalInContext')
const JSX_COMPILER_UTILS_PATH = require.resolve('vue-inbrowser-compiler-utils')

function isVueFile(filepath: string) {
	return /.vue$/.test(filepath)
}

function isImport(req: any): req is { importPath: string; path: string } {
	return !!req.importPath
}

export default function(this: StyleguidistContext, source: string) {
	const callback = this.async()
	const cb = callback ? callback : () => null
	examplesLoader.call(this, source).then(res => cb(undefined, res))
}

export async function examplesLoader(this: StyleguidistContext, src: string): Promise<string> {
	const filePath = this.request.split('!').pop()
	let source: string | false = src
	if (!filePath) return ''
	if (isVueFile(filePath)) {
		// if it's a vue file, the examples are in a docs block
		source = getComponentVueDoc(src, filePath)
	}
	const config = this._styleguidist
	const options = loaderUtils.getOptions(this) || {}
	const { file, displayName, shouldShowDefaultExample, customLangs } = options

	// Replace placeholders (__COMPONENT__) with the passed-in component name
	if (shouldShowDefaultExample && source) {
		const fullFilePath = path.join(path.dirname(filePath), file)
		const docs = await parse(fullFilePath)
		this.addDependency(fullFilePath)
		source = expandDefaultComponent(source, docs)
	}

	const updateExample = (props: ExampleLoader) => {
		const p = importCodeExampleFile(props, this.resourcePath, this)
		return config.updateExample ? config.updateExample(p, this.resourcePath) : p
	}

	// Load examples
	const examples = chunkify(source, updateExample, customLangs)

	const getExampleLiveImports = (source: string) =>
		getImports(getScript(source, config.jsxInExamples))

	// Find all import statements and require() calls in examples to make them
	// available in webpack context at runtime.
	// Note that we can't just use require() directly at runtime,
	// because webpack changes its name to something like __webpack__require__().
	const allCodeExamples = filter(examples, { type: 'code' })
	const requiresFromExamples = allCodeExamples.reduce(
		(requires: ({ importPath: string; path: string } | string)[], example) => {
			const requiresLocal = getExampleLiveImports(example.content)
			const importPath = example.settings.importpath
			return requires.concat(
				importPath ? requiresLocal.map(path => ({ importPath, path })) : requiresLocal
			)
		},
		[]
	)

	// Auto imported modules.
	// We don't need to do anything here to support explicit imports: they will
	// work because both imports (generated below and by rewrite-imports) will
	// be eventually transpiled to `var x = require('x')`, so we'll just have two
	// of them in the same scope, which is fine in non-strict mode
	const fullContext = {
		// Modules, provied by the user
		...config.context,
		// Append the current component module to make it accessible in examples
		// without an explicit import
		...(displayName && config.jsxInExamples ? { [displayName]: file } : {})
	}

	// All required or imported modules
	const allModules = [...requiresFromExamples, ...values<string>(fullContext)]

	// “Prerequire” modules required in Markdown examples and context so they
	// end up in a bundle and be available at runtime
	const allModulesCode = allModules.reduce(
		(requires: Record<string, Record<string, any>>, requireRequest) => {
			// if we are looking at a remote example
			// resolve the requires from there

			if (isImport(requireRequest)) {
				if (!requires[requireRequest.importPath]) {
					requires[requireRequest.importPath] = {}
				}
				const relativePath = /^\./.test(requireRequest.path)
					? path.join(requireRequest.importPath, requireRequest.path)
					: requireRequest.path
				requires[requireRequest.importPath][requireRequest.path] = requireIt(relativePath)
			} else {
				requires[requireRequest] = requireIt(requireRequest)
			}
			return requires
		},
		{}
	)

	// Require context modules so they are available in an example

	const requireContextCode = b.program(flatten(map(fullContext, resolveESModule)))

	// Stringify examples object except the evalInContext function
	const examplesWithEval = examples.map(example => {
		if (example.type === 'code') {
			let compiled: any = false
			if (config.codeSplit) {
				if (process.env.NODE_ENV === 'production') {
					// if we are not in prod, we want to avoid running examples through
					// buble all at the same time. We then tell it to calsculate on the fly
					const compiledExample = compile(example.content, {
						...config.compilerConfig,
						...(config.jsxInExamples ? { jsx: '__pragma__(h)', objectAssign: 'concatenate' } : {})
					})
					compiled = {
						script: compiledExample.script,
						template: compiledExample.template,
						style: compiledExample.style
					}
				}
			}

			const importPath = example.settings && example.settings.importpath
			const evalInContext = {
				toAST: () =>
					b.callExpression(
						b.memberExpression(b.identifier('evalInContext'), b.identifier('bind')),
						[
							b.identifier('null'),
							b.callExpression(
								b.memberExpression(b.identifier('requireInRuntime'), b.identifier('bind')),
								[b.identifier('null'), importPath ? b.literal(importPath) : b.identifier('null')]
							)
						]
					)
			}
			return { ...example, evalInContext, compiled }
		}
		return example
	})

	return `
if (module.hot) {
	module.hot.accept([])
}
var requireMap = ${generate(toAst(allModulesCode))};
var requireInRuntimeBase = require(${JSON.stringify(REQUIRE_IN_RUNTIME_PATH)});
var requireInRuntime = requireInRuntimeBase.bind(null, requireMap);
var evalInContextBase = require(${JSON.stringify(EVAL_IN_CONTEXT_PATH)});${
		config.jsxInExamples
			? `

var compilerUtils = require(${JSON.stringify(JSX_COMPILER_UTILS_PATH)});
var evalInContext = evalInContextBase.bind(null, 
	${JSON.stringify(generate(requireContextCode))}, 
	compilerUtils.adaptCreateElement, compilerUtils.concatenate);`
			: `
var evalInContext = evalInContextBase.bind(null, 
	${JSON.stringify(generate(requireContextCode))}, 
	null, null)`
	}
module.exports = ${generate(toAst(examplesWithEval))}`
}
