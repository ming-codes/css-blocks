import config from "@css-blocks/config";
import { AnalysisOptions, NodeJsImporter, Options as ParserOptions, OutputMode } from "@css-blocks/core";
import type { AST, ASTPlugin, ASTPluginEnvironment, NodeVisitor, Syntax } from "@glimmer/syntax";
import { ObjectDictionary } from "@opticss/util";
import type { InputNode } from "broccoli-node-api";
import TemplateCompilerPlugin, { HtmlBarsOptions } from "ember-cli-htmlbars/lib/template-compiler-plugin";
import type EmberApp from "ember-cli/lib/broccoli/ember-app";
import type EmberAddon from "ember-cli/lib/models/addon";
import type { AddonImplementation, ThisAddon, Tree } from "ember-cli/lib/models/addon";
import * as FSTree from "fs-tree-diff";
import { OptiCSSOptions } from "opticss";

type Writeable<T> = { -readonly [P in keyof T]: T[P] };

const BLOCK_GLOB = "**/*.block.{css,scss,sass,less,styl}";
interface EmberASTPluginEnvironment extends ASTPluginEnvironment {
  meta?: {
    moduleName?: string;
  };
}

class Visitor implements NodeVisitor {
  moduleName: string;
  syntax: Syntax;
  constructor(moduleName: string, syntax: Syntax) {
    this.moduleName = moduleName;
    this.syntax = syntax;
  }
  ElementNode(node: AST.ElementNode) {
    console.log(`visited ${this.syntax.print(node)}`);
  }
}
const NOOP_VISITOR = {};

class CSSBlocksTemplateCompilerPlugin extends TemplateCompilerPlugin {
  previousSourceTree: FSTree;
  cssBlocksOptions: CSSBlocksEmberOptions;
  constructor(inputTree: InputNode, htmlbarsOptions: HtmlBarsOptions, cssBlocksOptions: CSSBlocksEmberOptions) {
    super(inputTree, htmlbarsOptions);
    this.cssBlocksOptions = cssBlocksOptions;
    this.previousSourceTree = new FSTree();
  }
  async build() {
    let cssBlockEntries = this.input.entries(".", [BLOCK_GLOB]);
    let currentFSTree = FSTree.fromEntries(cssBlockEntries);
    let patch = this.previousSourceTree.calculatePatch(currentFSTree);
    let removedFiles = patch.filter((change) => change[0] === "unlink");
    if (cssBlockEntries.length === 0 && removedFiles.length > 0) {
      console.warn(`[WARN] ${removedFiles[0][1]} was just removed and the output directory was not cleaned up.`);
    }
    if (cssBlockEntries.length > 0) {
    }
    await super.build();
    if (cssBlockEntries.length > 0) {
      await super.build();
    }
  }
}

/**
 * The options that can be passed for css blocks to an ember-cli application.
 */
export interface CSSBlocksEmberAppOptions {
  "css-blocks"?: CSSBlocksEmberOptions;
}

export interface CSSBlocksEmberOptions {
  output?: string;
  aliases?: ObjectDictionary<string>;
  analysisOpts?: AnalysisOptions;
  parserOpts?: Writeable<ParserOptions>;
  optimization?: Partial<OptiCSSOptions>;
}

interface CSSBlocksAddon {
  findSiblingAddon<AddonType>(this: ThisAddon<CSSBlocksAddon>, name: string): ThisAddon<AddonType> | undefined;
  getOptions(this: ThisAddon<CSSBlocksAddon>): CSSBlocksEmberOptions;
  optionsForCacheInvalidation(this: ThisAddon<CSSBlocksAddon>): ObjectDictionary<unknown>;
  astPluginBuilder(env: EmberASTPluginEnvironment): ASTPlugin;
  _options?: CSSBlocksEmberOptions;
}
interface HTMLBarsAddon {
  getTemplateCompiler(inputTree: Tree, htmlbarsOptions: HtmlBarsOptions): TemplateCompilerPlugin;
}

function isAddon(parent: EmberAddon | EmberApp): parent is EmberAddon {
  return !!parent["findOwnAddonByName"];
}

const EMBER_ADDON: AddonImplementation<CSSBlocksAddon> = {
  name: "@css-blocks/ember",

  init(parent, project) {
    this._super.init.call(this, parent, project);
    this.app = this._findHost();
  },

  findSiblingAddon(name) {
    if (isAddon(this.parent)) {
      return this.parent.findOwnAddonByName(name);
    } else {
      this.project.findAddonByName(name);
    }
  },

  included(parent) {
    this._super.included.apply(this, [parent]);
    this._options = this.getOptions();
    let htmlBarsAddon = this.findSiblingAddon<HTMLBarsAddon>("ember-cli-htmlbars");
    if (!htmlBarsAddon) {
      throw new Error(`Using @css-blocks/ember on ${this.parent.name} also requires ember-cli-htmlbars to be an addon for ${this.parent.name}`);
    }
    htmlBarsAddon.getTemplateCompiler = (inputTree: Tree, htmlbarsOptions: HtmlBarsOptions) => {
      return new CSSBlocksTemplateCompilerPlugin(inputTree, htmlbarsOptions, this._options!);
    };
  },

  astPluginBuilder(env: EmberASTPluginEnvironment): ASTPlugin {
    let {meta, syntax } = env;
    let moduleName = meta?.moduleName;
    return {
      name: `CSS Blocks AST Plugin for ${moduleName}`,
      visitor: moduleName ? new Visitor(moduleName, syntax) : NOOP_VISITOR,
    };
  },

  setupPreprocessorRegistry(type, registry) {
    if (type !== "parent") { return; }
    // For Ember
    registry.add("htmlbars-ast-plugin", {
      name: "css-blocks-htmlbars",
      plugin: this.astPluginBuilder.bind(this),
      dependencyInvalidation: true,
      cacheKey: () => this.optionsForCacheInvalidation(),
      baseDir: () => __dirname,
    });
  },

  getOptions() {
    let app = this.app!;
    let root = app.project.root;
    let appOptions = app.options;

    if (!appOptions["css-blocks"]) {
      appOptions["css-blocks"] = {};
    }

    // Get CSS Blocks options provided by the application, if present.
    const options = <CSSBlocksEmberOptions>appOptions["css-blocks"]; // Do not clone! Contains non-json-safe data.
    if (!options.aliases) options.aliases = {};
    if (!options.analysisOpts) options.analysisOpts = {};
    if (!options.optimization) options.optimization = {};

    if (!options.parserOpts) {
      options.parserOpts = config.searchSync(root) || {};
    }

    // Use the node importer by default.
    options.parserOpts.importer = options.parserOpts.importer || new NodeJsImporter(options.aliases);

    // Optimization is always disabled for now, until we get project-wide analysis working.
    if (typeof options.optimization.enabled === "undefined") {
      options.optimization.enabled = app.isProduction;
    }

    // Update parserOpts to include the absolute path to our application code directory.
    if (!options.parserOpts.rootDir) {
      options.parserOpts.rootDir = root;
    }
    options.parserOpts.outputMode = OutputMode.BEM_UNIQUE;

    if (typeof options.output !== "string") {
      throw new Error(`Invalid css-blocks options in 'ember-cli-build.js': Output must be a string. Instead received ${options.output}.`);
    }
    return options;
  },

  optionsForCacheInvalidation() {
    let aliases = this._options!.aliases;
    let analysisOpts = this._options!.analysisOpts;
    let optimization = this._options!.optimization;
    let parserOpts: Writeable<ParserOptions> & {importerName?: string} = {};
    Object.assign(parserOpts, this._options!.parserOpts);
    let constructor = parserOpts.importer && parserOpts.importer.constructor;
    parserOpts.importerName = constructor && constructor.name;

    return {
      aliases,
      analysisOpts,
      optimization,
      parserOpts,
    };
  },
};

module.exports = EMBER_ADDON;