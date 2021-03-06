import {
  AttrValue,
  Block,
  BlockClass,
  ElementAnalysis,
  ResolvedConfiguration as CSSBlocksConfiguration,
  charInFile,
  isNamespaceReserved,
} from "@css-blocks/core";
import { AST, print } from "@glimmer/syntax";
import { SourceLocation, SourcePosition } from "@opticss/element-analysis";
import { assertNever } from "@opticss/util";
import * as debugGenerator from "debug";

import { GlimmerAnalysis } from "./Analyzer";
import { getEmberBuiltInStates, isEmberBuiltIn } from "./EmberBuiltins";
import { ResolvedFile } from "./Template";
import {
  AnalyzableNode,
  AnalyzableProperty,
  cssBlockError,
  isAnalyzableProperty,
  isAttrNode,
  isBooleanLiteral,
  isConcatStatement,
  isElementNode,
  isHashPair,
  isMustacheStatement,
  isNullLiteral,
  isNumberLiteral,
  isPathExpression,
  isStringLiteral,
  isSubExpression,
  isTextNode,
  isUndefinedLiteral,
} from "./utils";

// Expressions may be null when ElementAnalyzer is used in the second pass analysis
// to re-acquire analysis data for rewrites without storing AST nodes.
export type TernaryExpression = AST.Expression | AST.MustacheStatement | null;
export type StringExpression = AST.MustacheStatement | AST.ConcatStatement | AST.SubExpression | AST.PathExpression | null;
export type BooleanExpression = AST.Expression | AST.MustacheStatement;
export type TemplateElement  = ElementAnalysis<BooleanExpression, StringExpression, TernaryExpression>;
export type AttrRewriteMap = { [key: string]: TemplateElement };

const NAMESPACED_ATTR = /^([^:]+):([^:]+)$/;
const STYLE_IF = "style-if";
const STYLE_UNLESS = "style-unless";
const DEFAULT_BLOCK_NAME = "default";
const DEFAULT_BLOCK_NS = "block";

const debug = debugGenerator("css-blocks:glimmer:element-analyzer");

export function isStyleOfHelper(node: AnalyzableNode): node is AST.MustacheStatement | AST.SubExpression {
  if (!(isMustacheStatement(node) || isSubExpression(node))) return false;
  let name = node.path.original;
  return typeof name === "string" && name === "style-of";
}

export function isAnalyzedHelper(node: AnalyzableNode): node is AST.MustacheStatement | AST.BlockStatement {
  if (isElementNode(node)) return false;
  return isEmberBuiltIn(node.path.original) || isStyleOfHelper(node);
}

interface AnalyzableScope {
  type: "scope";
  namespace: string;
  property: AnalyzableProperty;
}

interface AnalyzableClass {
  type: "class";
  namespace: string;
  property: Exclude<AnalyzableProperty, AST.PathExpression>;
}

interface AnalyzableState {
  type: "state";
  namespace: string;
  name: string;
  property: AnalyzableProperty;
}

type AnalyzableAttribute = AnalyzableScope | AnalyzableClass | AnalyzableState;

export class ElementAnalyzer {
  analysis: GlimmerAnalysis;
  block: Block;
  template: ResolvedFile;
  cssBlocksOpts: CSSBlocksConfiguration;
  reservedClassNames: Set<string>;

  constructor(analysis: GlimmerAnalysis, cssBlocksOpts: CSSBlocksConfiguration) {
    this.analysis = analysis;
    this.block = analysis.getBlock(DEFAULT_BLOCK_NAME)!; // Local block check done elsewhere
    this.template = analysis.template;
    this.cssBlocksOpts = cssBlocksOpts;
    this.reservedClassNames = analysis.reservedClassNames();
  }

  analyze(node: AnalyzableNode, atRootElement: boolean, forbidNonBlockAttributes = false): AttrRewriteMap {
    return this._analyze(node, atRootElement, false, forbidNonBlockAttributes);
  }

  analyzeForRewrite(node: AnalyzableNode, atRootElement: boolean): AttrRewriteMap {
    return this._analyze(node, atRootElement, true);
  }

  private debugAnalysis(node: AnalyzableNode, atRootElement: boolean, element: TemplateElement) {
    if (!debug.enabled) return;
    let startTag = "";
    if (isElementNode(node)) {
      startTag = `<${node.tag} ${node.attributes.map(a => a.name).join(" ")}>`;
      debug(`Element ${startTag} is ${atRootElement ? "the root " : "a sub"}element at ${this.debugTemplateLocation(node)}`);
    }
    else {
      startTag = `{{${node.path.original} ${node.params.map(a => print(a)).join(" ")} ${node.hash.pairs.map((h) => print(h)).join(" ")}}}`;
      debug(`Component ${startTag} is ${atRootElement ? "the root " : "a sub"}element at ${this.debugTemplateLocation(node)}`);
    }
    debug(`↳ Analyzed as: ${element.forOptimizer(this.cssBlocksOpts)[0].toString()}`);
  }

  private debugTemplateLocation(node: AnalyzableNode) {
    let templatePath = this.cssBlocksOpts.importer.debugIdentifier(this.template.identifier, this.cssBlocksOpts);
    return charInFile(templatePath, node.loc.start);
  }
  private debugBlockPath(block: Block | null = null) {
    return this.cssBlocksOpts.importer.debugIdentifier((block || this.block).identifier, this.cssBlocksOpts);
  }

  private newElement(node: AnalyzableNode, forRewrite: boolean): TemplateElement {
    let label = isElementNode(node) ? node.tag : node.path.original as string;
    if (forRewrite) {
      return new ElementAnalysis<BooleanExpression, StringExpression, TernaryExpression>(nodeLocation(node), this.reservedClassNames, label);
    }
    else {
      return this.analysis.startElement<BooleanExpression, StringExpression, TernaryExpression>(nodeLocation(node), label);
    }
  }

  private finishElement(element: TemplateElement, forRewrite: boolean): void {
    element.seal();
    if (!forRewrite) { this.analysis.endElement(element); }
  }

  isAttributeAnalyzed(attributeName: string): [string, string] | [null, null] {
    if (NAMESPACED_ATTR.test(attributeName)) {
      let namespace = RegExp.$1;
      let attrName = RegExp.$2;
      if (isNamespaceReserved(namespace)) {
        return [null, null];
      } else {
        return [namespace, attrName];
      }
    } else {
      return [null, null];
    }
  }

  private _assertClassAttributeValue(node: AnalyzableNode, property: AnalyzableProperty): property is Exclude<AnalyzableProperty, AST.PathExpression> {
    if (isPathExpression(property)) {
      const name = this._getAnalyzableAttributeName(property);
      throw cssBlockError(`The ${name} attribute must contain a value and is not allowed to be purely positional. Did you mean ${name}="foo"?`, node, this.template);
    }
    return true;
  }

  private _getAnalyzableAttributeName(attribute: AnalyzableProperty): string | void {
    if (isAttrNode(attribute)) {
      return attribute.name;
    } else if (isHashPair(attribute)) {
      return attribute.key;
    } else if (isPathExpression(attribute)) {
      return attribute.original;
    } else {
      assertNever(attribute);
    }
  }

  *eachAnalyzedAttribute(node: AnalyzableNode, forbidNonBlockAttributes = false): Iterable<AnalyzableAttribute> {
    // Intital list may also contain general Expressions, we filter that later
    const propertyList: (AnalyzableProperty[] | AST.Expression[])[] = [];
    // set up the list of attributes (or multiple lists!) that we want to check
    // attributes for Element nodes, hash pairs and params for Handlebars nodes.
    if (isElementNode(node)) {
      propertyList.push(node.attributes);
    } else {
      propertyList.push(node.params, node.hash.pairs); // listed in order they'd need to be in Handlebars code
    }
    // looping through like this means the lists will be checked in order - eg, all hash pairs then all params
    // this isn't strictly needed, but helps with debugging.
    for (let list of propertyList) {
      // get each attribute, check it is analyzable, yield it if it parses.
      // will throw if the attribute name is not allowed
      // (ie - it's a positional prop but attribute requires data, like block:class)
      for (let property of list) {
        if (isAnalyzableProperty(property)) {
          const name = this._getAnalyzableAttributeName(property);
          if (name) {
            const [namespace, attrName] = this.isAttributeAnalyzed(name);
            if (namespace && attrName) {
              if (attrName === "class") {
                // When we upgrade to TS 3.7 we don't have to model this as
                // a type guard, we can use an assertion function signature.
                if (this._assertClassAttributeValue(node, property)) {
                  yield { type: "class", namespace, property };
                }
              } else if (attrName === "scope") {
                yield { type: "scope", namespace, property };
              } else {
                yield { type: "state", namespace, name: attrName, property };
              }
            } else {
              if (forbidNonBlockAttributes) {
                // We shouldn't have any properties that aren't namespaced!
                throw cssBlockError(`An attribute without a block namespace is forbidden in this context: ${name}`, node, this.template);
              }
            }
          }
        }
      }
    }
  }

  private _analyze(
    node: AnalyzableNode,
    atRootElement: boolean,
    forRewrite: boolean,
    forbidNonBlockAttributes = false,
  ): AttrRewriteMap {

    const attrRewrites = {};
    let element = attrRewrites["class"] = this.newElement(node, forRewrite);

    // The root element gets the block"s root class automatically.
    if (atRootElement) {
      element.addStaticClass(this.block.rootClass);
    }

    // Find the class or scope attribute and process it
    for (let analyzableAttr of this.eachAnalyzedAttribute(node, forbidNonBlockAttributes)) {
      if (analyzableAttr.type === "class") {
        this.processClass(analyzableAttr.namespace, analyzableAttr.property, element, forRewrite);
      } else if (analyzableAttr.type === "scope") {
        this.processScope(analyzableAttr.namespace, analyzableAttr.property, element, forRewrite);
      }
    }

    // validate that html elements aren't using the class attribute.
    if (isElementNode(node)) {
      for (let attribute of node.attributes) {
        if (attribute.name === "class") {
          throw cssBlockError(`The class attribute is forbidden. Did you mean block:class?`, node, this.template);
        }
      }
    }
    for (let analyzableAttr of this.eachAnalyzedAttribute(node)) {
      if (analyzableAttr.type === "state") {
        this.processState(analyzableAttr.namespace, analyzableAttr.name, analyzableAttr.property, element, forRewrite);
      }
    }

    this.finishElement(element, forRewrite);

    // If this is an Ember Built-In...
    if (!isElementNode(node) && isEmberBuiltIn(node.path.original)) {
      this.debugAnalysis(node, atRootElement, element);

      // Discover component state style attributes we need to add to the component invocation.
      let klasses = [...element.classesFound()];
      const attrToState = getEmberBuiltInStates(node.path.original);
      for (let attrName of Object.keys(attrToState)) {
        const stateName = attrToState[attrName];
        let element: ElementAnalysis<BooleanExpression, StringExpression, TernaryExpression> | undefined;
        for (let style of klasses) {
          let attr = style.resolveAttribute(stateName);
          if (!attr || !attr.presenceRule) { continue; }
          if (!element) {
            element = this.newElement(node, forRewrite);
          }
          attrRewrites[attrName] = element; // Only save this element on output if a state is found.
          if (!forRewrite) { element.addStaticClass(style); } // In rewrite mode we only want the states.
          element.addStaticAttr(style, attr.presenceRule);
        }
        if (element) {
          this.finishElement(element, forRewrite);
        }
      }
    }

    this.debugAnalysis(node, atRootElement, element);
    return attrRewrites;
  }

  private lookupClasses(namespace: string, classes: string, node: AST.Node): Array<BlockClass> {
    let classNames = classes.trim().split(/\s+/);
    let found = new Array<BlockClass>();
    for (let name of classNames) {
      found.push(this.lookupClass(namespace, name, node));
    }
    return found;
  }

  private lookupBlock(namespace: string, node: AST.Node): Block {
    let block = (namespace === DEFAULT_BLOCK_NS) ? this.block : this.block.getExportedBlock(namespace);
    if (block === null) {
      throw cssBlockError(`No block '${namespace}' is exported from ${this.debugBlockPath()}`, node, this.template);
    }
    return block;
  }

  private lookupClass(namespace: string, name: string, node: AST.Node): BlockClass {
    let block = this.lookupBlock(namespace, node);
    let found = block.resolveClass(name);
    if (found === null) {
      throw cssBlockError(`No class '${name}' was found in block at ${this.debugBlockPath(block)}`, node, this.template);
    }
    return found;
  }

  /**
   * Adds blocks and block classes to the current node from the class attribute.
   * As class is not allowed to be positional it will never be a PathExpression
   * so we exclude that from the node type
   */
  private processClass(namespace: string, node: Exclude<AnalyzableProperty, AST.PathExpression>, element: TemplateElement, forRewrite: boolean): void {
    let statements: AST.Node[];

    if (isConcatStatement(node.value)) {
      statements = node.value.parts;
    } else {
      statements = [node.value];
    }

    for (let statement of statements) {
      if (isTextNode(statement) || isStringLiteral(statement)) {
        let value = isTextNode(statement) ? statement.chars : statement.value;
        for (let container of this.lookupClasses(namespace, value, statement)) {
          element.addStaticClass(container);
        }
      }
      else if (isMustacheStatement(statement) || isSubExpression(statement)) {
        let helperType = isStyleIfHelper(statement);

        // If this is a `{{style-if}}` or `{{style-unless}}` helper:
        if (helperType) {
          let condition = statement.params[0];
          let whenTrue: Array<BlockClass> = [];
          let whenFalse: Array<BlockClass> = [];
          let mainBranch = statement.params[1];
          let elseBranch = statement.params[2];

          // Calculate the classes in the main branch of the style helper
          if (isStringLiteral(mainBranch)) {
            let containers = this.lookupClasses(namespace, mainBranch.value, mainBranch);
            if (helperType === "style-if") {
              whenTrue = containers;
            } else {
              whenFalse = containers;
            }
          } else {
            throw cssBlockError(`{{${helperType}}} expects a string literal as its second argument.`, mainBranch, this.template);
          }

          // Calculate the classes in the else branch of the style helper, if it exists.
          if (elseBranch) {
            if (isStringLiteral(elseBranch)) {
              let containers = this.lookupClasses(namespace, elseBranch.value, elseBranch);
              if (helperType === "style-if") {
                whenFalse = containers;
              } else {
                whenTrue = containers;
              }
            } else {
              throw cssBlockError(`{{${helperType}}} expects a string literal as its third argument.`, elseBranch, this.template);
            }
          }
          if (forRewrite) {
            element.addDynamicClasses({ condition, whenTrue, whenFalse });
          } else {
            element.addDynamicClasses({ condition: null, whenTrue, whenFalse });
          }

        } else {
          throw cssBlockError(`Only {{style-if}} or {{style-unless}} helpers are allowed in class attributes.`, node, this.template);
        }
      } else {
        throw cssBlockError(`Only string literals, {{style-if}} or {{style-unless}} are allowed in class attributes.`, node, this.template);
      }
    }
  }
  private processScope(namespace: string, node: AnalyzableProperty, element: TemplateElement, _forRewrite: boolean): void {
    let block = this.lookupBlock(namespace, node);

    if (isPathExpression(node)) {
      // if we're a path expression then we're implicitly true.
      // ie - block:scope is the same as block:scope="true"
      element.addStaticClass(block.rootClass);
    } else if (isTextNode(node.value)) {
      if (node.value.chars === "") {
        element.addStaticClass(block.rootClass);
      } else {
        throw cssBlockError("String literal values are not allowed for the scope attribute", node, this.template);
      }
    } else if (isBooleanLiteral(node.value)) {
      if (node.value.value) {
        element.addStaticClass(block.rootClass);
      }
    } else if (isMustacheStatement(node.value) || isSubExpression(node.value)) {
      // We don't have a way to represent a simple boolean conditional for classes like we do for states.
      // The rewrite might be slightly simpler if we add that.
      element.addDynamicClasses({
        condition: node.value,
        whenTrue: [block.rootClass],
        whenFalse: [],
      });
    }
  }

  /**
   * Adds states to the current node.
   */
  private processState(
    blockName: string,
    stateName: string,
    node: AnalyzableProperty,
    element: TemplateElement,
    forRewrite: boolean,
  ): void {
    let stateBlock = this.lookupBlock(blockName, node);
    let containers = element.classesForBlock(stateBlock);
    if (containers.length === 0) {
      throw cssBlockError(`No block or class from ${blockName || "the default block"} is assigned to the element so a state from that block cannot be used.`, node, this.template);
    }
    let staticSubStateName: string | undefined = undefined;
    let dynamicSubState: AST.MustacheStatement | AST.ConcatStatement | AST.SubExpression | AST.PathExpression | undefined = undefined;

    if (isPathExpression(node)) {
      // treat it like a boolean value true and do nothing
    } else if (isTextNode(node.value)) {
      staticSubStateName = node.value.chars;
      if (staticSubStateName === "") {
        staticSubStateName = undefined;
      }
    } else if (isStringLiteral(node.value)) {
      staticSubStateName = node.value.value;
      if (staticSubStateName === "") {
        staticSubStateName = undefined;
      }
    } else if (isNumberLiteral(node.value)) {
      staticSubStateName = node.value.value.toString();
      if (staticSubStateName === "") {
        staticSubStateName = undefined;
      }
    } else if (isBooleanLiteral(node.value)) {
      if (!node.value.value) {
        // Setting the state explicitly to false is the same as not having the state on the element.
        // So we just skip analysis of it. In the future we might want to partially analyze it to validate
        // that the state name exists
        return;
        // Setting it to true is the simplest way to set the state having no substates on an element when using the style-of helper.
      }
    } else if (isMustacheStatement(node.value) || isConcatStatement(node.value) || isSubExpression(node.value) || isPathExpression(node.value)) {
      dynamicSubState = node.value;
    } else if (isNullLiteral(node.value) || isUndefinedLiteral(node.value)) {
      // Setting the state explicitly to null or undefined is the same as not having the state on the element.
      // So we just skip analysis of it. In the future we might want to partially analyze it to validate
      // that the state name exists
      return;
    } else {
      assertNever(node.value);
    }

    let found = false;
    const errors: [string, AnalyzableProperty, ResolvedFile][] = [];
    for (let container of containers) {
      let stateGroup = container.resolveAttribute({
        namespace: "state",
        name: stateName,
      });
      let state: AttrValue | null | undefined = undefined;
      if (stateGroup && staticSubStateName) {
        found = true;
        state = stateGroup.resolveValue(staticSubStateName);
        if (state) {
          element.addStaticAttr(container, state);
        } else {
          throw cssBlockError(`No sub-state found named ${staticSubStateName} in state ${stateName} for ${container.asSource()} in ${blockName || "the default block"}.`, node, this.template);
        }
      } else if (stateGroup) {
        if (stateGroup.hasResolvedValues()) {
          found = true;
          if (dynamicSubState) {
            if (forRewrite) {
              element.addDynamicGroup(container, stateGroup, dynamicSubState);
            } else {
              element.addDynamicGroup(container, stateGroup, null);
            }
          } else {
            // TODO: when we add default sub states this is where that will go.
            throw cssBlockError(`No sub-state specified for ${stateName} for ${container.asSource()} in ${blockName || "the default block"}.`, node, this.template);
          }
        } else {
          found = true;
          if (dynamicSubState) {
            if (dynamicSubState.type === "ConcatStatement") {
              throw cssBlockError(`The dynamic statement for a boolean state must be set to a mustache statement with no additional text surrounding it.`, dynamicSubState, this.template);
            }
            let state = stateGroup.presenceRule;
            element.addDynamicAttr(container, state!, dynamicSubState);
          } else {
            element.addStaticAttr(container, stateGroup.presenceRule!);
          }
        }
      }
      else {
        if (staticSubStateName) {
          errors.push([`No state found named ${stateName} with a sub-state of ${staticSubStateName} for ${container.asSource()} in ${blockName || "the default block"}.`, node, this.template]);
        } else {
          errors.push([`No state(s) found named ${stateName} for ${container.asSource()} in ${blockName === "block" && "the default block" || blockName}.`, node, this.template]);
        }
      }
    }
    if (!found) {
      throw cssBlockError(...errors[0]);
    }
  }
}

function isStyleIfHelper(node: AST.MustacheStatement | AST.SubExpression): "style-if" | "style-unless" | undefined {
  if (node.path.type !== "PathExpression") { return undefined; }
  let parts: string[] = (node.path).parts;
  if (parts.length > 0) {
    let name = parts[0];
    if (name === STYLE_IF || name === STYLE_UNLESS) {
      return name;
    } else {
      return undefined;
    }
  } else {
    return undefined;
  }
}

function nodeLocation(node: AST.Node): SourceLocation {
  let start: SourcePosition = {
    filename: node.loc.source || undefined,
    line: node.loc.start.line,
    column: node.loc.start.column,
  };
  let end: SourcePosition = {
    filename: node.loc.source || undefined,
    line: node.loc.start.line,
    column: node.loc.start.column,
  };
  return { start, end };
}
