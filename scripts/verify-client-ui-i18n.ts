/**
 * Reject product UI copy embedded directly in Client and native-app source.
 *
 * Locale dictionaries are the only source files allowed to own translated
 * text. Presentation code receives copy through its typed `t` seat or through
 * an already-localized prop. This check covers JSX text and copy-bearing
 * attributes, plus the common data/helper forms that feed them.
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const MINIMUM_UI_SOURCES = 450

const COPY_ATTRIBUTES = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'aria-valuetext',
  'cancelLabel',
  'closeLabel',
  'confirmLabel',
  'copyLabel',
  'description',
  'emptyLabel',
  'label',
  'placeholder',
  'title',
  'truncatedLabel',
])
const COPY_ATTRIBUTE_SUFFIX = /(?:Aria|Copy|Description|Heading|Label|Message|Placeholder|Summary|Text|Title|Tooltip)$/

const COPY_NAME = /(?:^|_)(?:aria|copy|description|empty|heading|label|message|placeholder|summary|text|title|tooltip)(?:s|_.*)?$/i
const COPY_SUFFIX = /(?:aria|copy|description|empty|heading|label|labels|message|placeholder|summary|text|title|tooltip|tabs)$/i
const IMMUTABLE_LANGUAGE_TOKENS = new Set([
  'Function',
  'K',
  'M',
  'MB',
  'Symbol',
  'false',
  'function()',
  'n',
  'null',
  'true',
  'undefined',
])
const LOCALE_KEY = /^[a-z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)+$/
const ELECTRON_COPY_CONSTRUCTORS = new Set(['BrowserWindow', 'Notification'])
const ELECTRON_COPY_METHODS = new Set(['showErrorBox', 'showMessageBox', 'showMessageBoxSync'])

/** One hard-coded product-copy occurrence. */
export interface UiI18nViolation {
  /** One-based source column. */
  column: number
  /** Repository-relative source path. */
  file: string
  /** One-based source line. */
  line: number
  /** Why this literal is treated as product copy. */
  reason: string
  /** Compact literal text for the diagnostic. */
  text: string
}

function localeOwner(file: string): boolean {
  const normalized = file.replaceAll('\\', '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  return base === 'locale.ts'
    || base === 'locales.ts'
    || normalized.includes('/locales/')
}

function containsProductText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized !== ''
    && !IMMUTABLE_LANGUAGE_TOKENS.has(normalized)
    && !LOCALE_KEY.test(normalized)
    && /\p{L}/u.test(normalized)
}

function propertyName(node: ts.PropertyName | ts.BindingName): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined
}

function copyAttribute(name: string): boolean {
  return !name.endsWith('Key')
    && (COPY_ATTRIBUTES.has(name) || COPY_ATTRIBUTE_SUFFIX.test(name))
}

function compactText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`
}

function looksLikeNaturalText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return /\s|[\u3400-\u9fff]/u.test(normalized) || /^[A-Z]/.test(normalized)
}

/**
 * Find hard-coded product copy in one Client source file.
 * @param file - repository-relative path used in diagnostics.
 * @param sourceText - TypeScript or TSX source.
 * @returns violations in source order.
 */
export function findUiI18nViolations(file: string, sourceText: string): UiI18nViolation[] {
  if (localeOwner(file)) return []
  const normalizedFile = file.replaceAll('\\', '/')
  const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  let source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  )
  const needsBindings = normalizedFile === 'apps/desktop/src/main.ts'
    || source.statements.some(statement =>
      ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && (statement.moduleSpecifier.text === 'electron' || statement.moduleSpecifier.text === 'electron/main'))
  let checker: ts.TypeChecker | undefined
  if (needsBindings) {
    const options: ts.CompilerOptions = { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest }
    const host = ts.createCompilerHost(options, true)
    host.fileExists = candidate => candidate === file
    host.getSourceFile = candidate => candidate === file ? source : undefined
    host.readFile = candidate => candidate === file ? sourceText : undefined
    const program = ts.createProgram([file], options, host)
    source = program.getSourceFile(file) ?? source
    checker = program.getTypeChecker()
  }
  const violations = new Map<number, UiI18nViolation>()
  const electronConstructors = new Map<ts.Symbol, string>()
  const electronDialogs = new Set<ts.Symbol>()
  const electronNamespaces = new Set<ts.Symbol>()
  let fatalReporter: ts.Symbol | undefined

  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || (statement.moduleSpecifier.text !== 'electron' && statement.moduleSpecifier.text !== 'electron/main')
      || statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
    ) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined) continue
    if (ts.isNamespaceImport(bindings)) {
      const symbol = checker?.getSymbolAtLocation(bindings.name)
      if (symbol !== undefined) electronNamespaces.add(symbol)
      continue
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue
      const imported = element.propertyName?.text ?? element.name.text
      const symbol = checker?.getSymbolAtLocation(element.name)
      if (symbol === undefined) continue
      if (ELECTRON_COPY_CONSTRUCTORS.has(imported)) {
        electronConstructors.set(symbol, imported)
      } else if (imported === 'dialog') {
        electronDialogs.add(symbol)
      }
    }
  }
  if (normalizedFile === 'apps/desktop/src/main.ts') {
    const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'reportFatal')
    if (declaration?.name !== undefined) fatalReporter = checker?.getSymbolAtLocation(declaration.name)
  }

  const report = (
    node: ts.Node,
    text: string,
    reason: string,
    naturalOnly = false,
  ): void => {
    if (
      !containsProductText(text)
      || (naturalOnly && !looksLikeNaturalText(text))
      || violations.has(node.getStart(source))
    ) return
    const position = source.getLineAndCharacterOfPosition(node.getStart(source))
    violations.set(node.getStart(source), {
      column: position.character + 1,
      file,
      line: position.line + 1,
      reason,
      text: compactText(text),
    })
  }

  const collectExpression = (
    node: ts.Expression,
    reason: string,
    naturalOnly = false,
    traverseDynamicArguments = false,
  ): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      report(node, node.text, reason, naturalOnly)
      return
    }
    if (ts.isTemplateExpression(node)) {
      report(
        node,
        [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(''),
        reason,
        naturalOnly,
      )
      return
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      if (traverseDynamicArguments) {
        for (const argument of node.arguments ?? []) {
          collectExpression(argument, reason, naturalOnly, true)
        }
      }
      // A call or constructor result is dynamic outside a known presentation sink.
      return
    }
    if (
      ts.isParenthesizedExpression(node)
      || ts.isAsExpression(node)
      || ts.isSatisfiesExpression(node)
      || ts.isNonNullExpression(node)
    ) {
      collectExpression(node.expression, reason, naturalOnly, traverseDynamicArguments)
      return
    }
    if (ts.isConditionalExpression(node)) {
      collectExpression(node.whenTrue, reason, naturalOnly, traverseDynamicArguments)
      collectExpression(node.whenFalse, reason, naturalOnly, traverseDynamicArguments)
      return
    }
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        collectExpression(node.right, reason, naturalOnly, traverseDynamicArguments)
      } else if (
        node.operatorToken.kind === ts.SyntaxKind.PlusToken
        || node.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        collectExpression(node.left, reason, naturalOnly, traverseDynamicArguments)
        collectExpression(node.right, reason, naturalOnly, traverseDynamicArguments)
      }
      return
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (ts.isExpression(element)) {
          collectExpression(element, reason, naturalOnly, traverseDynamicArguments)
        }
      }
      return
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          const name = propertyName(property.name)
          const propertyOwnsCopy = name !== undefined
            && (COPY_NAME.test(name) || COPY_SUFFIX.test(name))
          collectExpression(
            property.initializer,
            reason,
            naturalOnly || !propertyOwnsCopy,
            traverseDynamicArguments,
          )
        }
      }
    }
  }

  const enclosingFunctionName = (node: ts.Node): string | undefined => {
    let current = node.parent
    while (!ts.isSourceFile(current)) {
      if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) {
        return current.name === undefined ? undefined : propertyName(current.name)
      }
      if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
        const parent = current.parent
        return ts.isVariableDeclaration(parent) ? propertyName(parent.name) : undefined
      }
      current = current.parent
    }
    return undefined
  }

  const hasExplicitStringReturn = (node: ts.Node): boolean => {
    let current = node.parent
    while (!ts.isSourceFile(current)) {
      if (
        ts.isFunctionDeclaration(current)
        || ts.isMethodDeclaration(current)
        || ts.isArrowFunction(current)
        || ts.isFunctionExpression(current)
      ) return current.type?.kind === ts.SyntaxKind.StringKeyword
      current = current.parent
    }
    return false
  }

  const electronConstructor = (expression: ts.LeftHandSideExpression): string | undefined => {
    if (ts.isIdentifier(expression)) {
      const symbol = checker?.getSymbolAtLocation(expression)
      return symbol === undefined ? undefined : electronConstructors.get(symbol)
    }
    if (
      ts.isPropertyAccessExpression(expression)
      && ts.isIdentifier(expression.expression)
      && ELECTRON_COPY_CONSTRUCTORS.has(expression.name.text)
    ) {
      const symbol = checker?.getSymbolAtLocation(expression.expression)
      if (symbol !== undefined && electronNamespaces.has(symbol)) return expression.name.text
    }
    return undefined
  }

  const electronDialogMethod = (expression: ts.LeftHandSideExpression): string | undefined => {
    if (!ts.isPropertyAccessExpression(expression) || !ELECTRON_COPY_METHODS.has(expression.name.text)) {
      return undefined
    }
    const owner = expression.expression
    if (ts.isIdentifier(owner)) {
      const symbol = checker?.getSymbolAtLocation(owner)
      if (symbol !== undefined && electronDialogs.has(symbol)) return expression.name.text
    }
    if (
      ts.isPropertyAccessExpression(owner)
      && owner.name.text === 'dialog'
      && ts.isIdentifier(owner.expression)
    ) {
      const symbol = checker?.getSymbolAtLocation(owner.expression)
      if (symbol !== undefined && electronNamespaces.has(symbol)) return expression.name.text
    }
    return undefined
  }

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) report(node, node.text, 'JSX text')

    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source)
      if (copyAttribute(name) && node.initializer !== undefined) {
        if (ts.isStringLiteral(node.initializer)) report(node.initializer, node.initializer.text, `${name} attribute`)
        else if (ts.isJsxExpression(node.initializer) && node.initializer.expression !== undefined) {
          collectExpression(node.initializer.expression, `${name} attribute`)
        }
      }
    }

    if (ts.isNewExpression(node)) {
      const constructor = electronConstructor(node.expression)
      if (constructor !== undefined) {
        for (const argument of node.arguments ?? []) {
          collectExpression(argument, `${constructor} option`)
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const method = electronDialogMethod(node.expression)
      if (method !== undefined) {
        for (const argument of node.arguments) {
          collectExpression(argument, `dialog.${method} argument`)
        }
      }
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && fatalReporter !== undefined) {
      if (checker?.getSymbolAtLocation(node.expression) === fatalReporter) {
        for (const argument of node.arguments) {
          collectExpression(argument, 'reportFatal argument', false, true)
        }
      }
    }

    if (
      ts.isJsxExpression(node)
      && node.expression !== undefined
      && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) collectExpression(node.expression, 'JSX child')

    if (file.endsWith('.tsx') && ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name)
      if (name !== undefined && (COPY_NAME.test(name) || COPY_SUFFIX.test(name))) {
        collectExpression(node.initializer, `${name} property`)
      }
    }

    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const name = propertyName(node.name)
      if (name !== undefined && (COPY_NAME.test(name) || COPY_SUFFIX.test(name))) {
        collectExpression(node.initializer, `${name} value`)
      }
    }

    if (ts.isBindingElement(node) && node.initializer !== undefined) {
      const name = propertyName(node.name)
      if (name !== undefined && (COPY_NAME.test(name) || COPY_SUFFIX.test(name))) {
        collectExpression(node.initializer, `${name} default value`)
      }
    }

    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      const name = enclosingFunctionName(node)
      if (name !== undefined && (COPY_NAME.test(name) || COPY_SUFFIX.test(name))) {
        collectExpression(node.expression, `${name} return value`)
      } else if (file.endsWith('.tsx') && hasExplicitStringReturn(node)) {
        collectExpression(node.expression, 'string return value', true)
      }
    }

    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...violations.values()].sort((left, right) => left.line - right.line || left.column - right.column)
}

/**
 * Resolve the normalized Client source root containing one TSX component.
 * @param file - Glob result using native or POSIX separators.
 * @returns Repository-relative `src/client` root, or undefined outside that tree.
 */
export function clientSourceRoot(file: string): string | undefined {
  const normalized = file.replaceAll('\\', '/')
  const marker = '/src/client/'
  const index = normalized.indexOf(marker)
  return index < 0 ? undefined : normalized.slice(0, index + marker.length - 1)
}

/**
 * Discover every source tree that owns product UI presentation.
 * @returns Repository-relative source paths in stable order.
 */
export function uiSourceFiles(): string[] {
  const clientComponentRoots = new Set(
    globSync('packages/*/*/src/client/**/*.tsx', { cwd: root })
      .map(clientSourceRoot)
      .filter((clientRoot): clientRoot is string => clientRoot !== undefined),
  )
  return [...new Set([
    ...globSync('packages/client/*/src/**/*.tsx', { cwd: root }),
    ...globSync('packages/client/ui-*/src/**/*.{ts,tsx}', { cwd: root }),
    ...[...clientComponentRoots].flatMap(clientRoot =>
      globSync(`${clientRoot}/**/*.{ts,tsx}`, { cwd: root })),
    ...globSync('apps/web/src/**/*.{ts,tsx}', { cwd: root }),
    ...globSync('apps/desktop/src/**/*.{ts,tsx}', { cwd: root }),
  ])]
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => !file.endsWith('.d.ts'))
    .sort()
}

function main(): void {
  const files = uiSourceFiles()
  if (files.length < MINIMUM_UI_SOURCES) {
    throw new Error(
      `verify-client-ui-i18n: discovery narrowed to ${files.length} source file(s); expected at least ${MINIMUM_UI_SOURCES}.`,
    )
  }
  const violations = files.flatMap(file =>
    findUiI18nViolations(file, readFileSync(resolve(root, file), 'utf8')))
  if (violations.length > 0) {
    console.error(`verify-client-ui-i18n: ${violations.length} hard-coded UI string(s):`)
    for (const violation of violations) {
      console.error(
        `  ${violation.file}:${violation.line}:${violation.column} ${violation.reason}: ${JSON.stringify(violation.text)}`,
      )
    }
    process.exitCode = 1
    return
  }
  console.log(`verify-client-ui-i18n: ${files.length} UI source file(s) use locale-owned copy.`)
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main()
