const Parser = require('web-tree-sitter');
const { Point, Range, spliceArray } = require('text-buffer');
const { CompositeDisposable, Emitter } = require('event-kit');
const ScopeDescriptor = require('./scope-descriptor')
const Token = require('./token');
const TokenizedLine = require('./tokenized-line');
const { matcherForSelector } = require('./selectors');

const createTree = require('./rb-tree');

const FUNCTION_TRUE = () => true;

function last(array) {
  return array[array.length - 1];
}

function removeLastOccurrenceOf(array, item) {
  return array.splice(array.lastIndexOf(item), 1);
}

function clamp (value, min, max) {
  if (value < min) { return min; }
  if (value > max) { return max; }
  return value;
}

function rangeForNode(node) {
  return new Range(node.startPosition, node.endPosition);
}

function nodeBreadth(node) {
  return node.endIndex - node.startIndex;
}

function resolveNodeDescriptor (node, descriptor) {
  let parts = descriptor.split('.');
  let result = node;
  while (result !== null && parts.length > 0) {
    let part = parts.shift();
    if (!result[part]) { return null; }
    result = result[part];
  }
  return result;
}

function resolveNodePosition (node, descriptor) {
  let parts = descriptor.split('.');
  let lastPart = parts.pop();
  let result = parts.length === 0 ?
    node :
    resolveNodeDescriptor(node, parts.join('.'));

  return result[lastPart];
}

// Patch tree-sitter syntax nodes the same way `TreeSitterLanguageMode` did so
// that we don't break anything that relied on `range` being present.
function ensureNodeIsPatched(node) {
  let done = node.range && node.range instanceof Range;
  if (done) { return; }
  let proto = Object.getPrototypeOf(node);

  Object.defineProperty(proto, 'range', {
    get () { return rangeForNode(this); }
  });

  // autocomplete-html expects a `closest` function to exist on nodes.
  Object.defineProperty(proto, 'closest', {
    value: function closest(types) {
      if (!Array.isArray(types)) { types = [types]; }
      let node = this;
      while (node) {
        if (types.includes(node.type)) { return node; }
        node = node.parent;
      }
      return null;
    }
  });
}


// Compares “informal” points like the ones in a tree-sitter tree; saves us
// from having to convert them to actual `Point`s.
function comparePoints(a, b) {
  const rows = a.row - b.row;
  if (rows === 0) {
    return a.column - b.column
  } else {
    return rows;
  }
}

// Acts like `comparePoints`, but treats starting and ending boundaries
// differently, making it so that ending boundaries are visited before starting
// boundaries.
function compareBoundaries (a, b) {
  if (!a.position) {
    a = { position: a, boundary: 'end' };
  }
  if (!b.position) {
    b = { position: b, boundary: 'end' };
  }
  let result = comparePoints(a.position, b.position);
  if (result !== 0) { return result; }
  if (a.boundary === b.boundary) { return 0; }
  return a.boundary === 'end' ? -1 : 1;
}

function isBetweenPoints (point, a, b) {
  let comp = comparePoints(a, b);
  let lesser = comp > 0 ? b : a;
  let greater = comp > 0 ? a : b;
  return comparePoints(point, lesser) >= 0 &&
    comparePoints(point, greater) <= 0;
}

const COMMENT_MATCHER = matcherForSelector('comment');
const MAX_RANGE = new Range(Point.ZERO, Point.INFINITY).freeze();

const VAR_ID = 257;
// const conversions = new Map([
//   ['function.method.builtin', 'keyword.other.special-method'],
//   ['number', 'constant.numeric'],
//   // 'punctuation.special':
//   // 'punctuation.bracket':
//   // 'string':
//   // 'embedded':
//   // 'punctuation.bracket':
//   ['string.special.regex', 'string.regexp']
// ])
class WASMTreeSitterLanguageMode {
  constructor({ buffer, grammar, config, grammars }) {
    this.lastId = 259;
    this.scopeNames = new Map([["variable", VAR_ID]]);
    this.scopeIds = new Map([[VAR_ID, "variable"]]);
    this.buffer = buffer;
    this.grammar = grammar;
    this.config = config;
    this.grammarRegistry = grammars;

    this.injectionsMarkerLayer = buffer.addMarkerLayer();

    this.rootScopeDescriptor = new ScopeDescriptor({
      scopes: [grammar.scopeName]
    });

    this.rootScopeId = this.getOrCreateScopeId(this.grammar.scopeName);

    this.emitter = new Emitter();
    this.isFoldableCache = [];

    this.tokenized = false;
    this.subscriptions = new CompositeDisposable;

    this.subscriptions.add(
      this.onDidTokenize(() => this.tokenized = true)
    );

    this.rootLanguage = null;
    this.rootLanguageLayer = null;

    this.grammarForLanguageString = this.grammarForLanguageString.bind(this);

    this.parsersByLanguage = new Map();

    this.ready = this.grammar.getLanguage()
      .then(language => {
        this.rootLanguage = language;
        this.rootLanguageLayer = new LanguageLayer(null, this, grammar, 0);
        return this.getOrCreateParserForLanguage(language);
      })
      .then(() => this.rootLanguageLayer.update(null))
      .then(() => this.emitter.emit('did-tokenize'));
  }

  destroy() {
    let layers = this.getAllLanguageLayers();
    for (let layer of layers) {
      layer?.destroy();
    }
    this.injectionsMarkerLayer?.destroy();
    this.rootLanguageLayer = null;
    this.subscriptions?.dispose();
  }

  getGrammar() {
    return this.grammar;
  }

  getLanguageId() {
    return this.grammar.scopeName;
  }

  getRootParser() {
    return this.getOrCreateParserForLanguage(this.rootLanguage);
  }

  getOrCreateParserForLanguage(language) {
    let existing = this.parsersByLanguage.get(language);
    if (existing) { return existing; }

    let parser = new Parser();
    parser.setLanguage(language);
    this.parsersByLanguage.set(language, parser);
    return parser;
  }

  bufferDidChange(change) {
    if (!this.rootLanguageLayer) { return; }

    let { oldRange, newRange, oldText, newText } = change;
    // this.newRanges.push(change.newRange);

    const startIndex = this.buffer.characterIndexForPosition(
      change.newRange.start
    );

    // Mark edits in the tree, but don't actually reparse until
    // `bufferDidFinishTransaction`.
    let edit = {
      startIndex,
      oldEndIndex: startIndex + oldText.length,
      newEndIndex: startIndex + newText.length,
      startPosition: oldRange.start,
      oldEndPosition: oldRange.end,
      newEndPosition: newRange.end
    };

    this.rootLanguageLayer.handleTextChange(edit, oldText, newText);

    for (const marker of this.injectionsMarkerLayer.getMarkers()) {
      marker.languageLayer.handleTextChange(edit, oldText, newText);
    }
  }

  bufferDidFinishTransaction({ changes }) {
    if (!this.rootLanguageLayer) { return; }
    for (let i = 0, { length } = changes; i < length; i++) {
      const { oldRange, newRange } = changes[i];
      spliceArray(
        this.isFoldableCache,
        newRange.start.row,
        oldRange.end.row - oldRange.start.row,
        { length: newRange.end.row - newRange.start.row }
      );
    }
    this.rootLanguageLayer.update(null);
  }

  emitRangeUpdate(range) {
    const startRow = range.start.row;
    const endRow = range.end.row;
    for (let row = startRow; row < endRow; row++) {
      this.isFoldableCache[row] = undefined;
    }
    this.emitter.emit('did-change-highlighting', range);
  }

  grammarForLanguageString(languageString) {
    let result =  this.grammarRegistry.treeSitterGrammarForLanguageString(
      languageString,
      'wasm'
    );
    return result;
  }

  // Called when any grammar is added or changed, on the off chance that it
  // affects an injection of ours.
  updateForInjection(grammar) {
    if (!this.rootLanguageLayer) { return; }
    this.rootLanguageLayer.updateInjections(grammar);
  }

  // _prepareInvalidations() {
  //   let nodes = this.oldNodeTexts
  //   let parentScopes = createTree(comparePoints)
  //
  //   this.newRanges.forEach(range => {
  //     const newNodeText = this.boundaries.lt(range.end).value?.definition
  //     if (newNodeText) nodes.add(newNodeText)
  //     const parent = findNodeInCurrentScope(
  //       this.boundaries, range.start, v => v.scope === 'open'
  //     )
  //     if (parent) parentScopes = parentScopes.insert(parent.position, parent)
  //   })
  //
  //   parentScopes.forEach((_, val) => {
  //     const from = val.position, to = val.closeScopeNode.position
  //     const range = new Range(from, to)
  //     this._invalidateReferences(range, nodes)
  //   })
  //   this.oldNodeTexts = new Set()
  //   this.newRanges = []
  // }

  // _invalidateReferences(range, invalidatedNames) {
  //   const {start, end} = range
  //   let it = this.boundaries.ge(start)
  //   while (it.hasNext) {
  //     const node = it.value.openNode
  //     if (node && !it.value.definition) {
  //       const txt = node.text
  //       if (invalidatedNames.has(txt)) {
  //         const range = new Range(node.startPosition, node.endPosition)
  //         this.emitter.emit('did-change-highlighting', range)
  //       }
  //     }
  //     it.next()
  //     if (comparePoints(it.key, end) >= 0) return
  //   }
  // }

  // _updateWithLocals(locals) {
  //   const size = locals.length
  //   for (let i = 0; i < size; i++) {
  //     const {name, node} = locals[i]
  //     const nextOne = locals[i+1]
  //
  //     const duplicatedLocalScope = nextOne &&
  //       comparePoints(node.startPosition, nextOne.node.startPosition) === 0 &&
  //       comparePoints(node.endPosition, nextOne.node.endPosition) === 0
  //     if (duplicatedLocalScope) {
  //       // Local reference have lower precedence over everything else
  //       if (name === 'local.reference') continue;
  //     }
  //
  //     let openNode = this._getOrInsert(node.startPosition, node)
  //     if (!openNode.openNode) openNode.openNode = node
  //     let closeNode = this._getOrInsert(node.endPosition, node)
  //     if (!closeNode.closeNode) closeNode.closeNode = node
  //
  //     if (name === "local.scope") {
  //       openNode.scope = "open"
  //       closeNode.scope = "close"
  //       openNode.closeScopeNode = closeNode
  //       closeNode.openScopeNode = openNode
  //       const parentNode = findNodeInCurrentScope(
  //         this.boundaries, node.startPosition, v => v.scope === 'open')
  //       const depth = parentNode?.depth || 0
  //       openNode.depth = depth + 1
  //       closeNode.depth = depth + 1
  //     } else if (name === "local.reference" && !openNode.definition) {
  //       const varName = node.text
  //       const varScope = findNodeInCurrentScope(
  //         this.boundaries, node.startPosition, v => v.definition === varName)
  //       if (varScope) {
  //         openNode.openScopeIds = varScope.openScopeIds
  //         closeNode.closeScopeIds = varScope.closeDefinition.closeScopeIds
  //       }
  //     } else if (name === "local.definition") {
  //       const shouldAddVarToScopes = openNode.openScopeIds.indexOf(VAR_ID) === -1
  //       if (shouldAddVarToScopes) {
  //         openNode.openScopeIds = [...openNode.openScopeIds, VAR_ID]
  //         closeNode.closeScopeIds = [VAR_ID, ...closeNode.closeScopeIds]
  //       }
  //
  //       openNode.definition = node.text
  //       openNode.closeDefinition = closeNode
  //     }
  //   }
  // }

  // _getOrInsert(key) {
  //   const existing = this.boundaries.get(key)
  //   if (existing) {
  //     return existing
  //   } else {
  //     const obj = {openScopeIds: [], closeScopeIds: [], position: key}
  //     this.boundaries = this.boundaries.insert(key, obj)
  //     return obj
  //   }
  // }

  /*
  Section - Highlighting
  */

  onDidTokenize(callback) {
    return this.emitter.on('did-tokenize', callback);
  }

  onDidChangeHighlighting(callback) {
    return this.emitter.on('did-change-highlighting', callback);
  }

  buildHighlightIterator() {
    if (!this.rootLanguageLayer) {
      return new NullLanguageModeHighlightIterator();
    }
    return new HighlightIterator(this);
  }

  classNameForScopeId(scopeId) {
    const scope = this.scopeIds.get(scopeId);
    if (scope) {
      return `syntax--${scope.replace(/\./g, ' syntax--')}`
    }
  }

  scopeNameForScopeId (scopeId) {
    return this.scopeIds.get(scopeId);
  }

  getOrCreateScopeId (name) {
    let id = this.scopeNames.get(name);
    if (!id) {
      this.lastId += 2;
      id = this.lastId;
      this.scopeNames.set(name, id);
      this.scopeIds.set(id, name);
    }
    return id;
  }

  // Behaves like `scopeDescriptorForPosition`, but returns a list of
  // tree-sitter node names. Useful for understanding tree-sitter parsing or
  // for writing syntax highlighting query files.
  syntaxTreeScopeDescriptorForPosition(point) {
    point = this.normalizePointForPositionQuery(point);
    let index = this.buffer.characterIndexForPosition(point);

    let layers = this.languageLayersAtPoint(point);
    let matches = [];

    for (let layer of layers) {
      if (!layer.tree) { continue; }
      let layerMatches = [];

      let root = layer.tree.rootNode;
      let current = root.descendantForIndex(index);

      while (current) {
        // Keep track of layer depth as well so we can use it to break ties
        // later.
        layerMatches.unshift({ node: current, depth: layer.depth });
        current = current.parent;
      }

      matches.push(...layerMatches);
    }

    // The nodes are mostly already sorted from smallest to largest,
    // but for files with multiple syntax trees (e.g. ERB), each tree's
    // nodes are separate. Sort the nodes from largest to smallest.
    matches.sort(
      (a, b) => (
        a.node.startIndex - b.node.startIndex ||
        b.node.endIndex - a.node.endIndex ||
        a.depth - b.depth
      )
    );

    let scopes = matches.map(({ node }) => (
      node.isNamed() ? node.type : `"${node.type}"`
    ));
    scopes.unshift(this.grammar.scopeName);

    return new ScopeDescriptor({ scopes });
  }

  // Returns the buffer range for the first scope to match the given scope
  // selector, starting with the smallest scope and moving outward.
  bufferRangeForScopeAtPosition(selector, point) {
    point = this.normalizePointForPositionQuery(point);

    if (typeof selector === 'function') {
      // We've been given a node-matching function instead of a scope name.
      let node = this.getSyntaxNodeAtPosition(point, selector);
      return node?.range;
    }

    let match = selector ? matcherForSelector(selector) : FUNCTION_TRUE;

    if (!this.rootLanguageLayer) {
      return match('text') ? this.buffer.getRange() : null;
    }

    let layers = this.languageLayersAtPoint(point);
    let results = [];
    for (let layer of layers) {
      let map = layer.scopeMapAtPosition(point);
      results.push(...map);
    }

    // We need the results sorted from smallest to biggest.
    results = results.sort((a, b) => {
      return nodeBreadth(a.node) - nodeBreadth(b.node);
    });

    for (let { name, node } of results) {
      if (match(name)) {
        return new Range(node.startPosition, node.endPosition);
      }
    }
  }

  scopeDescriptorForPosition (point) {
    if (!this.rootLanguageLayer) {
      return new ScopeDescriptor({ scopes: [this.grammar.scopeName, 'text'] });
    }

    point = this.normalizePointForPositionQuery(point);

    let results = this.rootLanguageLayer.scopeMapAtPosition(point);
    let injectionLayers = this.injectionLayersAtPoint(point);

    // Add in results from any applicable injection layers.
    for (let layer of injectionLayers) {
      let map = layer.scopeMapAtPosition(point);
      results.push(...map);

      // Make an artificial result for the root layer scope itself.
      if (layer.tree) {
        results.push({
          name: layer.grammar.scopeName,
          node: layer.tree.rootNode
        });
      }
    }

    // Order them from biggest to smallest.
    results = results.sort((a, b) => {
      return nodeBreadth(b.node) - nodeBreadth(a.node);
    });

    let scopes = results.map(cap => {
      return ScopeResolver.interpolateName(cap.name, cap.node)
    });

    if (scopes.length === 0 || scopes[0] !== this.grammar.scopeName) {
      scopes.unshift(this.grammar.scopeName);
    }
    return new ScopeDescriptor({ scopes });
  }

  normalizePointForPositionQuery(point) {
    // Convert bare arrays to points.
    if (Array.isArray(point)) { point = new Point(...point); }
    // Convert bare objects to points and ensure we're dealing with a copy.
    if (!('copy' in point)) {
      point = Point.fromObject(point, true);
    } else {
      point = point.copy();
    }

    // Constrain the point to the buffer range.
    point = this.buffer.clipPosition(point);

    // If the position is the end of a line, get scope of left character
    // instead of newline. This is to match TextMate behavior; see
    // https://github.com/atom/atom/issues/18463.
    if (
      point.column > 0 &&
      point.column === this.buffer.lineLengthForRow(point.row)
    ) {
      point.column--;
    }

    return point;
  }

  parse (language, oldTree, includedRanges) {
    // let devMode = atom.inDevMode();
    let parser = this.getOrCreateParserForLanguage(language);
    let text = this.buffer.getText();
    // TODO: Is there a better way to feed the parser the contents of the file?
    // if (devMode) { console.time('Parsing'); }
    const result = parser.parse(
      text,
      oldTree,
      { includedRanges }
    );
    // if (devMode) { console.timeEnd('Parsing'); }
    return result;
  }

  get tree () {
    return this.rootLanguageLayer?.tree }

  /*
  Section - Syntax Tree APIs
  */

  getSyntaxNodeContainingRange(range, where = FUNCTION_TRUE) {
    if (!this.rootLanguageLayer) { return null; }
    return this.getSyntaxNodeAndGrammarContainingRange(range, where)?.node;
  }

  getSyntaxNodeAndGrammarContainingRange(range, where = FUNCTION_TRUE) {
    if (!this.rootLanguageLayer) { return null; }

    let layersAtStart = this.languageLayersAtPoint(range.start);
    let layersAtEnd = this.languageLayersAtPoint(range.end);
    let sharedLayers = layersAtStart.filter(
      layer => layersAtEnd.includes(layer)
    );
    let indexStart = this.buffer.characterIndexForPosition(range.start);
    let indexEnd = this.buffer.characterIndexForPosition(range.end);
    let rangeBreadth = indexEnd - indexStart;

    sharedLayers.reverse();
    let results = [];
    for (let layer of sharedLayers) {
      if (!layer.tree) { continue; }
      let { grammar, depth } = layer;
      let rootNode = layer.tree.rootNode;

      if (!rootNode.range.containsRange(range)) {
        if (layer === this.rootLanguageLayer) {
          // This layer is responsible for the entire buffer, but our tree's
          // root node may not actually span that entire range. If the buffer
          // starts with empty lines, the tree may not start parsing until the
          // first non-whitespace character.
          //
          // But this is the root language layer, so we're going to pretend
          // that our tree's root node spans the entire buffer range.
          results.push({ node: rootNode, grammar, depth });
        }
        continue;
      }

      let node = this.getSyntaxNodeAtPosition(
        range.start,
        (node, nodeGrammar) => {
          // This node can touch either of our boundaries, but it must be
          // bigger than we are.
          //
          // We aren't checking against the predicate yet because passing the
          // predicate won't end our search. Users will reasonably expect that
          // returning `true` from the predicate will mean that the predicate
          // won't run any more. Since the predicate can have side effects, we
          // should keep this contract. That means throwing all nodes into the
          // bucket and not sifting through them until later.
          //
          // TODO: If we need to optimize performance here, we could compromise
          // by re-running the predicate at the end even though we already know
          // it's going to match.
          let breadth = node.endIndex - node.startIndex;
          return node.startIndex <= indexEnd &&
            node.endIndex >= indexEnd &&
            breadth > rangeBreadth &&
            nodeGrammar === grammar;
        }
      );

      if (node) {
        results.push({ node, grammar, depth });
      }
    }

    results.sort((a, b) => {
      return (
        // Favor smaller nodes first…
        nodeBreadth(a.node) - nodeBreadth(b.node) ||
        // …but deeper grammars in case of ties.
        b.depth - a.depth
      );
    });

    for (let { node, grammar } of results) {
      if (where(node, grammar)) {
        return { node, grammar };
      }
    }

    return null;
  }

  getRangeForSyntaxNodeContainingRange(range, where = FUNCTION_TRUE) {
    if (!this.rootLanguageLayer) { return null; }
    let node = this.getSyntaxNodeContainingRange(range, where);
    return node && rangeForNode(node);
  }

  // Return the smallest syntax node at the given position, or the smallest
  // node that matches the optional `where` predicate. The `where` predicate is
  // given the node and the associated grammar as arguments.
  getSyntaxNodeAtPosition(position, where = FUNCTION_TRUE) {
    if (!this.rootLanguageLayer) { return null; }
    let allLayers = this.languageLayersAtPoint(position);

    // We start with the deepest layer and move outward.
    //
    // TODO: Instead of sorting all candidates at the end, let's just keep
    // track of the smallest we've seen and then return it after all the
    // looping.
    allLayers.reverse();
    let results = [];
    for (let layer of allLayers) {
      if (!layer.tree) { continue; }
      let { depth, grammar } = layer;
      let rootNode = layer.tree.rootNode;
      if (!rootNode.range.containsPoint(position)) {
        if (layer === this.rootLanguageLayer) {
          // This layer is responsible for the entire buffer, but our tree's
          // root node may not actually span that entire range. If the buffer
          // starts with empty lines, the tree may not start parsing until the
          // first non-whitespace character.
          //
          // But this is the root language layer, so we're going to pretend
          // that our tree's root node spans the entire buffer range.
          if (where(rootNode, grammar)) {
            results.push({ rootNode: node, depth });
          }
        }
        continue;
      }

      let index = this.buffer.characterIndexForPosition(position);
      let node = rootNode.descendantForIndex(index);
      while (node) {
        // We aren't checking against the predicate yet because passing the
        // predicate won't end our search. Users will reasonably expect that
        // returning `true` from the predicate will mean that the predicate
        // won't run any more. Since the predicate can have side effects, we
        // should keep this contract. That means throwing all nodes into the
        // bucket and not sifting through them until later.
        //
        // TODO: If we need to optimize performance here, we could compromise
        // by re-running the predicate at the end even though we already know
        // it's going to match.
        results.push({ node, depth, grammar });
        node = node.parent;
      }
    }

    // Sort results from smallest to largest.
    results.sort((a, b) => {
      return (
        // Favor smaller nodes first…
        nodeBreadth(a.node) - nodeBreadth(b.node) ||
        // …but deeper grammars in case of ties.
        b.depth - a.depth
      );
    });

    for (let { node, grammar } of results) {
      if (where(node, grammar)) { return node; }
    }
    return null;
  }

  /*
  Section - Folds
  */
  getFoldableRangeContainingPoint(point) {
    let fold = this.getFoldRangeForRow(point.row);
    return fold ?? null;
  }

  getFoldableRanges() {
    if (!this.tokenized) { return []; }

    let layers = this.getAllLanguageLayers();
    let folds = [];
    for (let layer of layers) {
      let folds = layer.foldResolver.getAllFoldRanges();
      folds.push(...folds);
    }
    return folds;
  }

  // This method is improperly named, and is based on an assumption that every
  // nesting of folds carries an extra level of indentation. Several languages
  // violate that — perhaps most notably the C grammar in its use of nested
  // folds within `#ifdef` and its siblings.
  //
  // Instead, a level of `0` means “all folds,” a level of `1` means “all folds
  // that are contained by exactly one other fold,” and so on. This happens to
  // work as expected if you're working in a language where nested folds are
  // always indented relative to their enclosing fold, but it doesn't require
  // it.
  //
  getFoldableRangesAtIndentLevel(goalLevel) {
    if (!this.tokenized) { return []; }

    let rangeTree = createTree(comparePoints);

    // No easy way around this. The way to pull it off is to get _all_ folds in
    // the document on all language layers, then place their boundaries into a
    // red-black tree so we can iterate through them later in the proper order
    // while keeping track of nesting level.
    let layers = this.getAllLanguageLayers();
    for (let layer of layers) {
      let folds = layer.foldResolver.getAllFoldRanges();

      for (let fold of folds) {
        rangeTree = rangeTree.insert(fold.start, { start: fold });
        rangeTree = rangeTree.insert(fold.end, { end: fold });
      }
    }

    let foldsByLevel = new Index();
    let currentLevel = 0;
    let iterator = rangeTree.begin;

    // Whatever `currentLevel` is at when we reach a given `@fold.start` marker
    // is the depth of that marker.
    while (iterator.key) {
      let { start, end } = iterator.value;
      if (start) {
        foldsByLevel.add(currentLevel, start);
        currentLevel++;
      } else if (end) {
        currentLevel--;
      }
      iterator.next();
    }

    return foldsByLevel.get(goalLevel) || [];
  }

  // Adjusts a buffer position by a fixed number of characters.
  adjustPositionByOffset(position, offset) {
    let { buffer } = this;
    let index = buffer.characterIndexForPosition(position);
    index += offset;
    return buffer.positionForCharacterIndex(index);
  }

  isFoldableAtRow(row) {
    if (this.isFoldableCache[row] != null) {
      return this.isFoldableCache[row];
    }

    let isFoldable = !!this.getFoldRangeForRow(row);

    // Don't bother to cache this result before we're able to load the folds
    // query.
    if (this.tokenized) {
      // TODO: Cache actual ranges, not just booleans?
      this.isFoldableCache[row] = isFoldable;
    }
    return isFoldable;
  }

  getFoldRangeForRow(row) {
    if (!this.tokenized) { return null; }

    let rowEnd = this.buffer.lineLengthForRow(row);
    let point = new Point(row, rowEnd);
    let layers = this.languageLayersAtPoint(point);

    let leadingCandidate = null;
    // Multiple language layers may want to claim a fold for a given row.
    // Prefer deeper layers over shallower ones.
    for (let layer of layers) {
      let { depth } = layer;
      let candidateFold = layer.foldResolver.getFoldRangeForRow(row);
      if (!candidateFold) { continue; }
      if (!leadingCandidate || depth > leadingCandidate.depth) {
        leadingCandidate = { fold: candidateFold, depth };
      }
    }

    return leadingCandidate?.fold ?? null;
  }

  /*
  Section - Comments
  */

  // TODO: I know that old tree-sitter moved toward placing this data on the
  // grammar itself, but I would prefer to invert the order of these lookups.
  // As a config setting it can be scoped and overridden, but as a grammar
  // property it's just a fact of life that can't be worked around.
  //
  // TODO: Also, this should be revisited soon so that we can give the
  // `snippets` package the ability to ask about all of a grammar's comment
  // tokens — both line and block.
  //
  commentStringsForPosition(position) {
    // First ask the grammar for its comment strings.
    const range = this.firstNonWhitespaceRange(position.row) ||
      new Range(position, position);
    const { grammar } = this.getSyntaxNodeAndGrammarContainingRange(range);

    if (grammar) {
      let { commentStrings } = grammar;
      // Some languages don't have block comments, so only check for the start
      // delimiter.
      if (commentStrings && commentStrings.commentStartString) {
        return commentStrings;
      }
    }

    // Fall back to a lookup through the config system.
    const scope = this.scopeDescriptorForPosition(position);
    const commentStartEntries = this.config.getAll(
      'editor.commentStart', { scope });
    const commentEndEntries = this.config.getAll(
      'editor.commentEnd', { scope });

    const commentStartEntry = commentStartEntries[0];
    const commentEndEntry = commentEndEntries.find(entry => (
      entry.scopeSelector === commentStartEntry.scopeSelector
    ));
    return {
      commentStartString: commentStartEntry && commentStartEntry.value,
      commentEndString: commentEndEntry && commentEndEntry.value
    };
  }

  isRowCommented(row) {
    const range = this.firstNonWhitespaceRange(row);
    if (range) {
      let descriptor = this.scopeDescriptorForPosition(range.start);
      return descriptor.getScopesArray().some(
        scope => COMMENT_MATCHER(scope)
      );
    }
    return false;
  }

  /*
  Section - auto-indent
  */

  indentLevelForLine(line, tabLength) {
    let indentLength = 0;
    for (let i = 0, { length } = line; i < length; i++) {
      const char = line[i];
      if (char === '\t') {
        indentLength += tabLength - (indentLength % tabLength);
      } else if (char === ' ') {
        indentLength++;
      } else {
        break;
      }
    }
    return indentLength / tabLength;
  }

  // Get the suggested indentation level for an existing line in the buffer.
  //
  // * bufferRow - A {Number} indicating the buffer row
  //
  // Returns a {Number}.
  suggestedIndentForBufferRow(row, tabLength, options = {}) {
    if (row === 0) { return 0; }

    let comparisonRow = row - 1;
    if (options.skipBlankLines !== false) {
      // Move upward until we find the a line with text on it.
      while (this.buffer.isRowBlank(comparisonRow) && comparisonRow > 0) {
        comparisonRow--;
      }
    }

    // TODO: What's the right place to measure from? If we measure from the
    // beginning of the new row, the injection's language layer might not know
    // whether it controls that point. Feels better to measure from the end of
    // the previous non-whitespace row, but we'll see.
    let comparisonRowEnd = new Point(
      comparisonRow,
      this.buffer.lineLengthForRow(comparisonRow)
    );

    const lastLineIndent = this.indentLevelForLine(
      this.buffer.lineForRow(comparisonRow), tabLength
    );

    let controllingLayer = this.controllingLayerAtPoint(
      comparisonRowEnd,
      (layer) => !!layer.indentsQuery
    );

    if (!controllingLayer) { return lastLineIndent; }
    let { indentsQuery } = controllingLayer;

    // The tree officially gets re-parsed later in the change lifecycle, on
    // `bufferDidFinishTransaction`. But we need a parse here so that we can
    // get accurate captures. This will tend not to be costly because — usually
    // — the only change since the last parse will have been a carriage return.
    //
    // TODO: This is imperfect on injection layers because the last known
    // update ranges could be stale. To know the exact range to re-parse we'd
    // need to synchronously parse the root tree and however many intermediate
    // layers' trees in between. That's possible in theory, but it wouldn't be
    // a lot of fun. I haven't actually seen this break, though, so we'll live
    // with it for now.
    let indentTree = controllingLayer.forceAnonymousParse(
      controllingLayer.currentNodeRangeSet
    );

    // Capture in two phases. The first phase affects whether this line should
    // be indented from the previous line.
    let indentCaptures = indentsQuery.captures(
      indentTree.rootNode,
      { row: comparisonRow, column: 0 },
      { row: row, column: 0 }
    );

    let seenIndentCapture = false;
    let indentDelta = 0;
    for (let capture of indentCaptures) {
      let { node, name } = capture;

      // Ignore anything that ends before the range we care about.
      if (node.endPosition.row < comparisonRow) { continue; }

      // Ignore “phantom” nodes that aren't present in the buffer.
      if (node.text === '') { continue; }

      if (name === 'indent') {
        seenIndentCapture = true;
        indentDelta++;
      } else if (name === 'indent_end') {
        // `indent_end` tokens don't count for anything unless they happen
        // after the first `indent` token. They only tell us whether an indent
        // that _seems_ like it should happen is cancelled out.
        //
        // Consider:
        //
        // } else if (foo) {
        //
        // We should still indent the succeeding line because the initial `}`
        // does not “cancel out” the `{` at the end of the line. On the other
        // hand:
        //
        // } else if (foo) {}
        //
        // The second `}` _does_ cancel out the first occurrence of `{` because
        // it comes later.
        if (!seenIndentCapture) { continue; }
        indentDelta--;
      }
    }
    indentDelta = clamp(indentDelta, 0, 1);

    let dedentDelta = 0;

    if (options.skipDedentCheck !== true) {
      // The second phase tells us whether this line should be dedented from the
      // previous line.
      let dedentCaptures = indentsQuery.captures(
        indentTree.rootNode,
        { row: row, column: 0 },
        { row: row + 1, column: 0 }
      );

      let currentRowText = this.buffer.lineForRow(row);
      dedentCaptures = dedentCaptures.filter(capture => {
        // Imagine you've got:
        //
        // { ^foo, bar } = something
        //
        // and the caret represents the cursor. Pressing Enter will move
        // everything after the cursor to a new line and _should_ indent the
        // line, even though there's a closing brace on the new line that would
        // otherwise mark a dedent.
        //
        // Thus we don't want to honor a dedent unless it's the first
        // non-whitespace content in the line. We'll use similar logic for
        // `suggestedIndentForEditedBufferRow`.
        let { text } = capture.node;
        // Filter out phantom nodes.
        if (!text) { return false; }
        return currentRowText.trim().startsWith(text);
      });

      dedentDelta = this.getIndentDeltaFromCaptures(
        dedentCaptures,
        ['indent_end', 'branch']
      );
      dedentDelta = clamp(dedentDelta, -1, 0);
    }

    return lastLineIndent + indentDelta + dedentDelta;
  }

  // Get the suggested indentation level for a line in the buffer on which the
  // user is currently typing. This may return a different result from
  // {::suggestedIndentForBufferRow} in order to avoid unexpected changes in
  // indentation. It may also return undefined if no change should be made.
  //
  // * row - The row {Number}
  //
  // Returns a {Number}.
  suggestedIndentForEditedBufferRow(row, tabLength) {
    let scopeResolver = new ScopeResolver(this.buffer);
    if (row === 0) { return 0; }

    let controllingLayer = this.controllingLayerAtPoint(
      new Point(row, 0),
      (layer) => !!layer.indentsQuery
    );

    let { indentsQuery } = controllingLayer;
    if (!indentsQuery) { return undefined; }

    // Indents query won't work unless we re-parse the tree. Since we're typing
    // one character at a time, this should not be costly.
    let indentTree = controllingLayer.forceAnonymousParse(
      controllingLayer.currentNodeRangeSet
    );
    const indents = indentsQuery.captures(
      indentTree.rootNode,
      { row: row, column: 0 },
      { row: row + 1, column: 0 }
    );

    let lineText = this.buffer.lineForRow(row).trim();

    const currentLineIndent = this.indentLevelForLine(
      this.buffer.lineForRow(row), tabLength);

    // This is the indent level that is suggested from context — the level we'd
    // have if this line were completely blank. We won't alter the indent level
    // of the current line — even if it's “wrong” — unless typing triggers a
    // dedent. But once a dedent is triggered, we should dedent one level from
    // this value, not from the current line indent.
    const originalLineIndent = this.suggestedIndentForBufferRow(row, tabLength,
      { skipDedentCheck: true });

    for (let indent of indents) {
      let { node } = indent;
      if (!scopeResolver.store(indent, null)) {
        continue;
      }
      if (node.startPosition.row !== row) { continue; }
      if (indent.name !== 'branch') { continue; }
      if (node.text !== lineText) { continue; }
      return Math.max(0, originalLineIndent - 1);
    }

    return currentLineIndent;
  }

  // Get the suggested indentation level for a given line of text, if it were
  // inserted at the given row in the buffer.
  //
  // * bufferRow - A {Number} indicating the buffer row
  //
  // Returns a {Number}.
  suggestedIndentForLineAtBufferRow(row, line, tabLength) {
    return this.suggestedIndentForBufferRow(row, tabLength);
  }

  // Private

  getAllInjectionLayers() {
    let markers =  this.injectionsMarkerLayer.getMarkers();
    return markers.map(m => m.languageLayer);
  }

  getAllLanguageLayers() {
    return [
      this.rootLanguageLayer,
      ...this.getAllInjectionLayers()
    ];
  }

  injectionLayersAtPoint(point) {
    let injectionMarkers = this.injectionsMarkerLayer.findMarkers({
      containsPosition: point
    });

    injectionMarkers = injectionMarkers.sort((a, b) => {
      return a.getRange().compare(b.getRange());
    });

    return injectionMarkers.map(m => m.languageLayer);
  }

  languageLayersAtPoint(point) {
    let injectionLayers = this.injectionLayersAtPoint(point);
    injectionLayers = injectionLayers.sort((a, b) => b.depth - a.depth);
    return [
      this.rootLanguageLayer,
      ...injectionLayers
    ];
  }

  // Returns the deepest language layer at a given point, or optionally the
  // deepest layer to fulfill a criterion.
  controllingLayerAtPoint(point, where = FUNCTION_TRUE) {
    let layers = this.languageLayersAtPoint(point);
    // Sort deeper layers first.
    layers.sort((a, b) => b.depth - a.depth);

    return layers.find(layer => where(layer)) ?? null;
  }

  firstNonWhitespaceRange(row) {
    return this.buffer.findInRangeSync(
      /\S/,
      new Range(new Point(row, 0), new Point(row, Infinity))
    );
  }

  getIndentDeltaFromCaptures(captures, consider = null) {
    let delta = 0;
    let positionSet = new Set;
    if (!consider) {
      consider = ['indent', 'indent_end', 'branch'];
    }
    for (let { name, node } of captures) {
      // Ignore phantom captures.
      let text = node.text;
      if (!text || !text.length) { continue; }

      if (!consider.includes(name)) { continue; }

      // A given node may be marked with both (e.g.) `indent_end` and `branch`.
      // Only consider a given range once.
      let key = `${node.startIndex}/${node.endIndex}`;
      if (positionSet.has(key)) {
        continue;
      } else {
        positionSet.add(key);
      }

      if (name === 'indent') {
        delta++;
      } else if (name === 'indent_end' || name === 'branch') {
        delta--;
      }
    }
    return delta;
  }

  // DEPRECATED

  tokenizedLineForRow(row) {
    const lineText = this.buffer.lineForRow(row);
    const tokens = [];

    const iterator = this.buildHighlightIterator();
    let start = { row, column: 0 };

    const scopes = iterator.seek(start, row) || [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const end = { ...iterator.getPosition() };
      if (end.row > row) {
        end.row = row;
        end.column = lineText.length;
      }

      if (end.column > start.column) {
        tokens.push(
          new Token({
            value: lineText.substring(start.column, end.column),
            scopes: scopes.map(s => this.scopeNameForScopeId(s))
          })
        );
      }

      if (end.column < lineText.length) {
        const closeScopeCount = iterator.getCloseScopeIds().length;
        for (let i = 0; i < closeScopeCount; i++) {
          scopes.pop();
        }
        scopes.push(...iterator.getOpenScopeIds());
        start = end;
        iterator.moveToSuccessor();
      } else {
        break;
      }
    }

    return new TokenizedLine({
      openScopes: [],
      text: lineText,
      tokens,
      tags: [],
      ruleStack: [],
      lineEnding: this.buffer.lineEndingForRow(row),
      tokenIterator: null,
      grammar: this.grammar
    });
  }

  tokenForPosition(point) {
    if (Array.isArray(point)) {
      point = new Point(...point);
    }
    const scopes = this.scopeDescriptorForPosition(point).getScopesArray();
    let range = this.bufferRangeForScopeAtPosition(
      last(scopes),
      point
    );
    return new Token({
      scopes,
      value: this.buffer.getTextInRange(range)
    });
  }
}

// Responsible for deciding the ranges of folds on a given language layer.
//
// Understands two kinds of folds:
//
// * A “simple” fold is one with a capture name of `@fold` in a folds query. It
//   can be described with only one capture. It starts at the end of the row
//   that the captured node starts on, and ends at a configurable position
//   controlled by the `endAt` adjustment (which defaults to
//   `lastChild.startPosition`).
//
//   Simple folds should be used whenever you're able to predict the end of a
//   fold range simply from holding a reference to its starting node.
//
// * A “divided” fold is one where the two ends of the fold must be described
//   in two separate query captures. It starts at the end of the row of a node
//   captured with the name of `@fold.start`, and it ends at the very next
//   `@fold.end` that it encounters in the document.
//
//   When determining the end of a fold that is marked with `@fold.start`,
//   Pulsar will search the buffer for the next “balanced” occurrence of
//   `@fold.end`. For instance, when trying to find a match for a `@fold.start`
//   on row 9, Pulsar might encounter another `@fold.start` on row 10,
//   and would then understand that the next `@fold.end` it sees will end
//   _that_ fold and not the one we're looking for. If Pulsar _does not_ find a
//   matching `@fold.end`, the given line will not be considered to be
//   foldable.
//
//   Because they can trigger a buffer-wide search, divided folds are
//   not recommended to use unless they're truly needed. Use them only when the
//   structure of the syntax tree doesn't allow you to determine the end of the
//   fold without applying your own heuristic.
//
class FoldResolver {
  constructor(buffer, layer) {
    this.buffer = buffer;
    this.layer = layer;

    this.boundaries = null;
    this.boundariesStartingPosition = null;
  }

  // Retrieve the first valid fold range for this row in this language layer —
  // that is, the first fold range that spans more than one row.
  getFoldRangeForRow(row) {
    if (!this.layer.tree || !this.layer.foldsQuery) { return null; }
    let start = Point.fromObject({ row, column: 0 });
    let end = Point.fromObject({ row: row + 1, column: 0 });

    let iterator = this.getOrCreateBoundariesIterator(
      this.layer.tree.rootNode, start, end);

    while (iterator.key) {
      if (comparePoints(iterator.key.position, end) > 0) { break; }
      let capture = iterator.value;
      let { name } = capture;
      if (name === 'fold') {
        let range = this.resolveRangeForSimpleFold(capture);
        if (this.isValidFold(range)) { return range; }
      } else if (name === 'fold.start') {
        let range = this.resolveRangeForDividedFold(capture);
        if (this.isValidFold(range)) { return range; }
      }
      iterator.next();
    }

    return null;
  }

  isValidFold(range) {
    return range && range.end.row > range.start.row;
  }

  // Returns all valid fold ranges in this language layer.
  getAllFoldRanges() {
    if (!this.layer.tree || !this.layer.foldsQuery) { return []; }
    let range = this.layer.getExtent();
    let iterator = this.getOrCreateBoundariesIterator(
      this.layer.tree.rootNode, range.start, range.end);

    let results = [];
    while (iterator.key) {
      let capture = iterator.value;
      let { name } = capture;
      if (name === 'fold') {
        let range = this.resolveRangeForSimpleFold(capture);
        if (this.isValidFold(range)) { results.push(range); }
      } else if (name === 'fold.start') {
        let range = this.resolveRangeForDividedFold(capture);
        if (this.isValidFold(range)) { results.push(range); }
      }
      iterator.next();
    }

    return results;
  }

  // Invalidates the fold resolver's cached boundary data in response to a
  // change in the document.
  reset() {
    this.boundaries = null;
    this.boundariesRange = null;
  }

  canReuseBoundaries(start, end) {
    if (!this.boundariesRange) { return false; }
    return this.boundariesRange.containsRange(new Range(start, end));
  }

  getOrCreateBoundariesIterator(rootNode, start, end) {
    if (this.canReuseBoundaries(start, end)) {
      let result = this.boundaries.ge(start);
      return result;
    }

    // The red-black tree we use here is a bit more complex up front than the
    // one we use for syntax boundaries, because I didn't want the added
    // complexity later on of having to aggregate boundaries when they share a
    // position in the buffer.
    //
    // Instead of keying off of a plain buffer position, this tree also
    // considers whether the boundary is a fold start or a fold end. If one
    // boundary ends at the same point that another one starts, the ending
    // boundary will be visited first.
    let boundaries = createTree(compareBoundaries);
    let captures = this.layer.foldsQuery.captures(rootNode, start, end);

    for (let capture of captures) {
      if (capture.name === 'fold') {
        boundaries = boundaries.insert({
          position: capture.node.startPosition,
          boundary: 'start'
        }, capture);
      } else {
        let key = this.keyForDividedFold(capture);
        boundaries = boundaries.insert(key, capture);
      }
    }

    this.boundaries = boundaries;
    this.boundariesRange = new Range(start, end);

    return boundaries.ge(start);
  }

  // Given a `@fold.start` capture, queries the rest of the layer's extent to
  // find a matching `@fold.end`.
  resolveRangeForDividedFold(capture) {
    let { name } = capture;
    let key = this.keyForDividedFold(capture);
    if (name !== 'fold.start') { return null; }

    let extent = this.layer.getExtent();

    let iterator = this.getOrCreateBoundariesIterator(
      this.layer.tree.rootNode,
      key.position,
      extent.end
    );

    let depth = 0;
    let matchedEndCapture = null;

    while (iterator.key && comparePoints(iterator.key.position, extent.end) <= 0) {
      let { name, node } = iterator.value;
      let isSelf = node.id === capture.node.id;
      if (name === 'fold.end' && !isSelf) {
        if (depth === 0) {
          matchedEndCapture = iterator.value;
          break;
        } else {
          depth--;
        }
      } else if (name === 'fold.start' && !isSelf) {
        // A later `fold.start` has occurred, so the next `fold.end` will pair
        // with it, not with ours.
        depth++;
      }
      iterator.next();
    }

    // There's no guarantee that a matching `@fold.end` will even appear, so if
    // it doesn't, then this row does not contain a valid fold.
    if (!matchedEndCapture) { return null; }

    return new Range(
      this.resolvePositionForDividedFold(capture),
      this.resolvePositionForDividedFold(matchedEndCapture)
    );
  }

  keyForDividedFold(capture) {
    let { name, node } = capture;
    if (name === 'fold.start') {
      // Eventually we'll alter this position to occur at the end of the given
      // row, but we keep the original value around for a while because we want
      // to honor whichever fold technically happens “earliest” on a given row.
      return { position: node.startPosition, boundary: 'start' };
    } else if (name === 'fold.end') {
      return { position: node.startPosition, boundary: 'end' };
    } else {
      return null;
    }
  }

  resolvePositionForDividedFold(capture) {
    let { name, node } = capture;
    if (name === 'fold.start') {
      return new Point(node.startPosition.row, Infinity);
    } else if (name === 'fold.end') {
      let end = node.startPosition;
      if (end.column === 0) {
        // If the fold ends at the start of the line, adjust it so that it
        // actually ends at the end of the previous line. This behavior is
        // implied in the existing specs.
        return new Point(end.row - 1, Infinity);
      } else {
        return new Point.fromObject(end, true);
      }
    } else {
      return null;
    }
  }

  resolveRangeForSimpleFold(capture) {
    let { node, setProperties: props } = capture;
    let start = new Point(node.startPosition.row, Infinity);
    let end = node.endPosition;

    let defaultOptions = { endAt: 'lastChild.startPosition' };
    let options = { ...defaultOptions, ...props };

    for (let key in options) {
      if (!FoldResolver.ADJUSTMENTS[key]) { continue; }
      let value = options[key];
      end = FoldResolver.ADJUSTMENTS[key](
        end, node, value, props, this.layer);
    }

    end = Point.fromObject(end, true);
    end = this.buffer.clipPosition(end);

    if (end.row <= start.row) { return null; }
    return new Range(start, end);
  }
}

FoldResolver.ADJUSTMENTS = {
  // Use a node position descriptor to describe where the fold should end.
  // Overrides the default descriptor of `lastChild.startPosition`.
  endAt (end, node, value) {
    end = resolveNodePosition(node, value);
    return end;
  },

  // Adjust the end point by a fixed number of characters in either direction.
  // Will cross rows if necessary.
  offsetEnd (end, node, value, props, layer) {
    let { languageMode } = layer;
    value = Number(value);
    if (isNaN(value)) { return end; }
    return languageMode.adjustPositionByOffset(end, value);
  },

  // Adjust the column of the fold's end point. Use `0` to end the fold at the
  // start of the line.
  adjustEndColumn (end, node, value, props, layer) {
    let column = Number(value);
    if (isNaN(column)) { return end; }
    let newEnd = Point.fromObject({ column, row: end.row });
    return layer.buffer.clipPosition(newEnd);
  },

  // Adjust the end point to be immediately before the current line begins.
  // Useful if the end line also contains the start of a fold and thus should
  // stay on a separate screen line.
  adjustToEndOfPreviousRow (end) {
    return new Point(end.row - 1, Infinity);
  }
};

class NullLanguageModeHighlightIterator {
  seek() {
    return [];
  }
  compare() {
    return 1;
  }
  moveToSuccessor() {}
  getPosition() {
    return Point.INFINITY;
  }
  getOpenScopeIds() {
    return [];
  }
  getCloseScopeIds() {
    return [];
  }
}

class NullLayerHighlightIterator {
  seek() {
    return null;
  }
  compare() {
    return 1;
  }
  moveToSuccessor() {}
  getPosition() {
    return Point.INFINITY;
  }
  getOpenScopeIds() {
    return [];
  }
  getCloseScopeIds() {
    return [];
  }
}

// function findNodeInCurrentScope(boundaries, position, filter) {
//   let iterator = boundaries.ge(position)
//   while (iterator.hasPrev) {
//     iterator.prev()
//     const value = iterator.value
//     if (filter(value)) return value
//
//     if (value.scope === 'close') {
//       // If we have a closing scope, there's an "inner scope" that we will
//       // ignore, and move the iterator BEFORE the inner scope position
//       iterator = boundaries.lt(value.openScopeNode.position)
//     } else if (value.scope === 'open') {
//       // But, if we find an "open" scope, we check depth. If it's `1`, we
//       // got into the last nested scope we were inside, so it's time to quit
//       if (value.depth === 1) return
//     }
//   }
// }

// An iterator for marking boundaries in the buffer to apply syntax
// highlighting.
//
// Manages a collection of `LayerHighlightIterators`, which are the classes
// doing the real work of marking boundaries. `HighlightIterator` is in charge
// of understanding, at any given point, which of the iterators needs to be
// advanced next.
class HighlightIterator {
  constructor(languageMode) {
    this.languageMode = languageMode;
    this.iterators = null;
  }

  seek(start, endRow) {
    let { buffer, rootLanguageLayer } = this.languageMode;
    if (!rootLanguageLayer) { return []; }

    let end = {
      row: endRow,
      column: buffer.lineLengthForRow(endRow)
    };

    this.end = end;
    this.iterators = [];

    const injectionMarkers = this.languageMode.injectionsMarkerLayer.findMarkers(
      {
        intersectsRange: new Range(
          start,
          new Point(endRow + 1, 0)
        )
      }
    );

    const iterator = this.languageMode.rootLanguageLayer.buildHighlightIterator();

    let openScopes = [];
    // The contract of `LayerHighlightIterator#seek` is different from the
    // contract of `HighlightIterator#seek`. Instead of having it return an
    // array of open scopes at the given point, we give it an array that it can
    // push items into if needed; but its return value is a boolean that tells
    // us whether we should use this iterator at all. It will return `true` if
    // it needs to mark anything in the specified range, and `false` otherwise.
    let result = iterator.seek(start, endRow, openScopes);
    if (result) {
      this.iterators.push(iterator);
    }

    for (const marker of injectionMarkers) {
      const iterator = marker.languageLayer.buildHighlightIterator();
      let result = iterator.seek(start, endRow, openScopes);
      if (result) {
        this.iterators.push(iterator);
      }
    }

    // Sort the iterators so that the last one in the array is the earliest
    // in the document, and represents the current position.
    this.iterators.sort((a, b) => b.compare(a));

    this.detectCoveredScope();

    return openScopes;
  }

  moveToSuccessor () {
    // `this.iterators` is _always_ sorted from farthest position to nearest
    // position, so the last item in the collection is always the next one to
    // act.
    let leader = last(this.iterators);
    if (leader.moveToSuccessor()) {
      // It was able to move to a successor, so now we have to "file" it into
      // the right place in `this.iterators` so that the sorting is correct.
      const leaderIndex = this.iterators.length - 1;
      let i = leaderIndex;
      while (i > 0 && this.iterators[i - 1].compare(leader) < 0) {
        i--;
      }
      if (i < leaderIndex) {
        this.iterators.splice(i, 0, this.iterators.pop());
      }
    } else {
      // It was not able to move to a successor, so it must be done. Remove it
      // from the collection.
      this.iterators.pop();
    }

    this.detectCoveredScope();
  }

  getPosition () {
    let iterator = last(this.iterators || []);
    if (iterator) {
      // this.logPosition();
      return iterator.getPosition();
    } else {
      return Point.INFINITY;
    }
  }

  getCloseScopeIds() {
    let iterator = last(this.iterators);
    if (this.currentScopeIsCovered) {
      // console.log(
      //   iterator.name,
      //   iterator.depth,
      //   'would close',
      //   iterator._inspectScopes(
      //     iterator.getCloseScopeIds()
      //   ),
      //   'at',
      //   iterator.getPosition().toString(),
      //   'but scope is covered!'
      // );
    } else {
      // console.log(
      //   iterator.name,
      //   iterator.depth,
      //   'CLOSING',
      //   iterator.getPosition().toString(),
      //   iterator._inspectScopes(
      //     iterator.getCloseScopeIds()
      //   )
      // );
    }
    if (iterator && !this.currentScopeIsCovered) {
      return iterator.getCloseScopeIds();
    }
    return [];
  }

  getOpenScopeIds() {
    let iterator = last(this.iterators);
    // let ids = iterator.getOpenScopeIds();
    if (this.currentScopeIsCovered) {
      // console.log(
      //   iterator.name,
      //   iterator.depth,
      //   'would open',
      //   iterator._inspectScopes(
      //     iterator.getOpenScopeIds()
      //   ),
      //   'at',
      //   iterator.getPosition().toString(),
      //   'but scope is covered!'
      // );
    } else {
      // console.log(
      //   iterator.name,
      //   iterator.depth,
      //   'OPENING',
      //   iterator.getPosition().toString(),
      //   iterator._inspectScopes(
      //     iterator.getOpenScopeIds()
      //   )
      // );
    }
    if (iterator && !this.currentScopeIsCovered) {
      return iterator.getOpenScopeIds();
    }
    return [];
  }

  // Detect whether or not another more deeply-nested language layer has a
  // scope boundary at this same position. If so, the current language layer's
  // scope boundary should not be reported.
  //
  // This also will only avoid the scenario where two iterators want to
  // highlight the _exact same_ boundary. If a root language layer wants to
  // mark a boundary that isn't present in an injection's boundary list, the
  // root will be allowed to proceed.
  //
  // TODO: This only works for comparing the first two iterators; anything
  // deeper than that will be ignored. This probably isn't a problem, but we'll
  // see.

  // EXPERIMENT: Rather than the commented-out logic below, let's try something
  // more holistic that is off by default but triggered via an explicit
  // `coverShallowerScopes` option in `atom.grammars.addInjectionPoint`.
  detectCoveredScope() {
    const layerCount = this.iterators.length;
    if (layerCount > 1) {
      const rest = [...this.iterators];
      const leader = rest.pop();
      let covered = rest.some(it => {
        return it.coversIteratorAtPosition(
          leader,
          leader.getPosition()
        );
      });

      if (covered) {
        this.currentScopeIsCovered = true;
        return;
      }
      // const first = this.iterators[layerCount - 1];
      // const next = this.iterators[layerCount - 2];
      //
      // // In the tree-sitter EJS grammar I encountered a situation where an EJS
      // // scope was incorrectly being shadowed because `source.js` wanted to
      // // _close_ a scope on the same boundary that `text.html.ejs` wanted to
      // // _open_ one. This is one (clumsy) way to prevent that outcome.
      // let bothOpeningScopes = first.getOpenScopeIds().length > 0 && next.getOpenScopeIds().length > 0;
      // let bothClosingScopes = first.getCloseScopeIds().length > 0 && next.getCloseScopeIds().length > 0;
      //
      // if (
      //   comparePoints(next.getPosition(), first.getPosition()) === 0 &&
      //   next.isClosingScopes() === first.isClosingScopes() &&
      //   next.depth > first.depth &&
      //   !next.isAtInjectionBoundary() &&
      //   (bothOpeningScopes || bothClosingScopes)
      // ) {
      //   this.currentScopeIsCovered = true;
      //   return;
      // }
    }

    this.currentScopeIsCovered = false;
  }

  logPosition() {
    let iterator = last(this.iterators);
    iterator.logPosition();
  }
}

// Iterates through everything that a `LanguageLayer` is responsible for,
// marking boundaries for scope insertion.
class LayerHighlightIterator {
  constructor (languageLayer) {
    this.languageLayer = languageLayer;
    this.name = languageLayer.grammar.scopeName;
    this.depth = languageLayer.depth;

    let { injectionPoint } = this.languageLayer;

    this.coverShallowerScopes = injectionPoint?.coverShallowerScopes ?? false
  }

  // If this isn't the root language layer, we need to make sure this iterator
  // doesn't try to go past its marker boundary.
  _getEndPosition (endRow) {
    let { marker } = this.languageLayer;
    let { buffer } = this.languageLayer.languageMode;
    let naiveEndPoint = new Point(
      endRow,
      buffer.lineLengthForRow(endRow)
    );

    if (marker) {
      return Point.min(marker.getRange().end, naiveEndPoint)
    } else {
      return buffer.clipPosition(naiveEndPoint);
    }
  }

  // TODO: This still doesn't make much sense, so I suppose it's good that
  // we've now made it an opt-in feature.
  //
  // The main problem with this logic is that it runs the risk of covering only
  // one half of a pair of boundaries. If a scope range from the root layer is
  // coterminous with a scope range from an injection layer, that's easy to
  // detect and handle; but what if the root layer's range starts at the same
  // point but ends later? We'd prevent the root layer from opening the scope
  // but not closing it.
  //
  // I still don't fully understand the use cases for `detectCoveredScope`,
  // though I assume there are at least a few. I am quite sure, however, that
  // if we want an injection layer to veto a shallower layer's scope, it needs
  // to happen in a way that either prevents _both_ boundaries or allows _both_
  // boundaries. I'm not sure how to pull that off at this point, though.
  //
  // https://github.com/atom/atom/pull/19556 has good discussion about the
  // impetus for this feature.
  coversIteratorAtPosition(iterator, position) {
    // When does a layer prevent another layer from applying scopes?

    // When the option is asserted…
    if (!this.coverShallowerScopes) { return false; }

    // …and this iterator is deeper than the other…
    if (iterator.depth > this.depth) { return false; }

    // …and this iterator's ranges actually include this position.
    let ranges = this.languageLayer.currentNodeRangeSet;
    if (ranges) {
      return ranges.some(range => {
        // return comparePoints(position, range.startPosition) > 0 &&
        //   comparePoints(position, range.endPosition) < 0;
        return isBetweenPoints(position, range.startPosition, range.endPosition);
      });
    }

    // TODO: Despite all this, we may want to allow parent layers to apply
    // scopes at the very edges of this layer's ranges/extent, or to at least
    // make it a configurable behavior.
  }

  seek(start, endRow, previousOpenScopes) {

    let end = this._getEndPosition(endRow);
    // let isDevMode = atom.inDevMode();

    // let timeKey;
    // if (isDevMode) {
    //   timeKey = `${this.name} getSyntaxBoundaries`;
    //   console.time(timeKey);
    // }
    let [boundaries, openScopes] = this.languageLayer.getSyntaxBoundaries(
      start,
      end,
      { includeOpenScopes: true }
    );

    // An iterator might have no boundaries to apply but still be able to tell
    // us about a scope that should be open at the beginning of the range.
    previousOpenScopes.push(...openScopes);

    this.iterator = boundaries?.begin;
    if (!this.iterator?.key) { return false; }

    this.start = Point.fromObject(start, true);
    this.end = end;
    // if (isDevMode) { console.timeEnd(timeKey); }
    return true;
  }

  isAtInjectionBoundary () {
    let position = Point.fromObject(this.iterator.key);
    return position.isEqual(this.start) || position.isEqual(this.end);
  }

  _inspectScopes (ids) {
    if (Array.isArray(ids)) {
      return ids.map(id => this._inspectScopes(id)).join(', ')
    }
    return this.languageLayer.languageMode.scopeNameForScopeId(ids);
  }

  getOpenScopeIds () {
    // console.log(
    //   this.name,
    //   this.depth,
    //   'OPENING',
    //   this.getPosition().toString(),
    //   this._inspectScopes(
    //     this.iterator.value.openScopeIds
    //   )
    // );
    return [...this.iterator.value.openScopeIds];
  }

  getCloseScopeIds () {
    // console.log(
    //   this.name,
    //   'CLOSING',
    //   this.getPosition().toString(),
    //   this._inspectScopes(
    //     this.iterator.value.closeScopeIds
    //   )
    // );
    return [...this.iterator.value.closeScopeIds];
  }

  getPosition () {
    return this.iterator.key || Point.INFINITY;
  }

  logPosition () {
    let pos = this.getPosition();

    let { languageMode } = this.languageLayer;

    console.log(
      `[highlight] (${pos.row}, ${pos.column})`,
      'close',
      this.iterator.value.closeScopeIds.map(id => languageMode.scopeNameForScopeId(id)),
      'open',
      this.iterator.value.openScopeIds.map(id => languageMode.scopeNameForScopeId(id)),
      'next?',
      this.iterator.hasNext
    );
  }

  compare(other) {
    // First, favor the one whose current position is earlier.
    const result = comparePoints(this.iterator.key, other.iterator.key);
    if (result !== 0) { return result; }

    // Failing that, favor iterators that need to close scopes over those that
    // don't.
    let ours = this.getCloseScopeIds();
    let theirs = other.getCloseScopeIds();

    if (ours.length > 0 && theirs.length === 0) {
      return -1;
    } else if (theirs > 0 && ours.length === 0) {
      return 1;
    }

    // Failing that, favor the shallower layer.
    //
    // TODO: Is this universally true? Feels like we should favor the shallower
    // layer when both are opening scopes, and favor the deeper layer when both
    // are closing scopes.
    return this.languageLayer.depth - other.languageLayer.depth;
  }

  moveToSuccessor () {
    if (!this.iterator.hasNext) { return false; }
    if (this.done) { return false; }
    this.iterator.next();
    this.done = this.isDone();
    return true;
  }

  peekAtSuccessor () {
    if (!this.iterator.hasNext) { return null; }
    this.iterator.next();
    let key = this.iterator.key;
    this.iterator.prev();
    return key;
  }

  isDone() {
    if (!this.iterator.hasNext) { return true; }
    if (!this.end) { return false; }

    let next = this.peekAtSuccessor();
    return comparePoints(next, this.end) > 0;
  }
}

// Manages all aspects of a given language's parsing duties over a given region
// of the buffer.
//
// The base `LanguageLayer` that's in charge of the entire buffer is the "root"
// `LanguageLayer`. Other `LanguageLayer`s are created when injections are
// required. Those injected languages may require injections themselves,
// meaning a layer could be of arbitrary depth.
//
// For example: a PHP file could inject an HTML grammar, which in turn injects
// a JavaScript grammar for `SCRIPT` blocks, which in turn injects a regex
// grammar for regular expressions.
//
// Thus, for many editor-related tasks that depend on the context of the
// cursor, we should figure out how many different `LanguageLayer`s are
// operating in that particular region, and either (a) compose their output or
// (b) choose the output of the most specific layer that meets our needs,
// depending on the task.
//
class LanguageLayer {
  constructor(marker, languageMode, grammar, depth, injectionPoint) {
    this.marker = marker;
    this.languageMode = languageMode;
    this.buffer = this.languageMode.buffer;
    this.grammar = grammar;
    this.depth = depth;
    this.injectionPoint = injectionPoint;

    this.subscriptions = new CompositeDisposable;

    this.languageLoaded = this.grammar.getLanguage().then(async (language) => {
      this.language = language;
      // TODO: Currently, we require a syntax query, but we might want to
      // rethink this. There are use cases for treating the root layer merely
      // as a way to delegate to injections, in which case syntax highlighting
      // wouldn't be needed.
      try {
        this.syntaxQuery = await this.grammar.getQuery('syntaxQuery');
      } catch (error) {
        console.warn(`Grammar ${grammar.scopeName} failed to load its "highlights.scm" file. Please fix this error or contact the maintainer.`);
        console.error(error);
      }

      // All other queries are optional. Regular expression language layers,
      // for instance, don't really have a need for any of these.
      let otherQueries = ['foldsQuery', 'indentsQuery', 'localsQuery'];

      for (let queryType of otherQueries) {
        if (grammar[queryType]) {
          try {
            let query = await this.grammar.getQuery(queryType);
            this[queryType] = query;
          } catch (error) {
            console.warn(`Grammar ${grammar.scopeName} failed to load its ${queryType}. Please fix this error or contact the maintainer.`);
          }
        }
      }

      if (atom.inDevMode()) {
        // In dev mode, changes to query files should be applied in real time.
        // This allows someone to save, e.g., `highlights.scm` and immediately
        // see the impact of their change.
        this.observeQueryFileChanges();
      }
    });

    this.tree = null;
    this.scopeResolver = new ScopeResolver(
      this,
      (name) => this.languageMode.getOrCreateScopeId(name)
    );
    this.foldResolver = new FoldResolver(this.buffer, this);

    this.languageScopeId = this.languageMode.getOrCreateScopeId(this.grammar.scopeName);
  }

  inspect() {
    let { scopeName } = this.grammar;
    return `[LanguageLayer ${scopeName || '(anonymous)'} depth=${this.depth}]`;
  }

  destroy() {
    this.tree = null;
    this.destroyed = true;
    this.marker?.destroy();
    this.foldResolver?.reset();
    this.subscriptions.dispose();

    for (const marker of this.languageMode.injectionsMarkerLayer.getMarkers()) {
      if (marker.parentLanguageLayer === this) {
        marker.languageLayer.destroy();
      }
    }
  }

  observeQueryFileChanges() {
    this.subscriptions.add(
      this.grammar.onDidChangeQueryFile(async ({ queryType }) => {
        if (this._pendingQueryFileChange) { return; }
        this._pendingQueryFileChange = true;

        try {
          if (!this[queryType]) { return; }

          let query = await this.grammar.getQuery(queryType);
          this[queryType] = query;

          // Force a re-highlight of this layer's entire region.
          let range = this.getExtent();
          this.languageMode.emitRangeUpdate(range);
          this._pendingQueryFileChange = false;
        } catch (error) {
          console.error(`Error parsing query file: ${queryType}`);
          console.error(error);
          this._pendingQueryFileChange = false;
        }
      })
    );
  }

  getExtent() {
    return this.marker?.getRange() ?? this.languageMode.buffer.getRange();
  }

  // Run a highlights query for the given range and process the raw captures
  // through a `ScopeResolver`.
  getSyntaxBoundaries(from, to) {
    let { buffer } = this.languageMode;
    if (!this.language || !this.tree) { return []; }
    if (!this.grammar.getLanguageSync()) { return []; }
    if (!this.syntaxQuery) { return []; }

    from = buffer.clipPosition(Point.fromObject(from, true));
    to = buffer.clipPosition(Point.fromObject(to, true));

    let boundaries = createTree(comparePoints);
    let extent = this.marker ? this.marker.getRange() : this.buffer.getRange();

    const captures = this.syntaxQuery.captures(this.tree.rootNode, from, to);

    let isRootLanguageLayer = this.depth === 0;
    this.scopeResolver.reset();

    // TODO: For injection layers, there's the extent, which covers the range
    // of whichever node matches the injection point's `type`. And there's the
    // content, meaning whatever set of nodes is returned from the point's
    // `content` callback. Neither one is a great representation of the true
    // range being injected into. We need better logic around when we add an
    // injection layer's scope to a given range.
    let languageScopeDiffersFromParent = true;
    if (this.marker) {
      // We don't want to duplicate the scope ID when a language injects
      // _itself_. This happens in C (for `#define`s) and in Rust (for macros),
      // among others.
      let parentLayer = this.marker?.parentLanguageLayer;
      languageScopeDiffersFromParent = this.languageScopeId !== parentLayer.languageScopeId;
    }

    // Ensure the whole source file (or whole bounds of the injection) is
    // annotated with the root language scope name. We _do not_ want to leave
    // this up to the grammar author; it's too important.
    if (languageScopeDiffersFromParent && from.isEqual(extent.start) && from.column === 0) {
      this.scopeResolver.setBoundary(from, this.languageScopeId, 'open');
    }

    for (let capture of captures) {
      let { node } = capture;
      // Phantom nodes invented by the parse tree.
      if (node.text === '') { continue; }

      // Ask the `ScopeResolver` to process each capture in turn. Some captures
      // will be ignored if they fail certain tests, and some will have their
      // original range altered.
      this.scopeResolver.store(capture);
    }

    if (languageScopeDiffersFromParent && to.isEqual(extent.end)) {
      this.scopeResolver.setBoundary(to, this.languageScopeId, 'close');
    }

    let alreadyOpenScopes = [];
    if (isRootLanguageLayer && from.isGreaterThan(extent.start)) {
      alreadyOpenScopes.push(this.languageScopeId);
    }

    for (let [point, data] of this.scopeResolver) {
      // The boundaries that occur before the start of our range will tell us
      // which scopes should already be open when our range starts.
      if (point.isLessThan(from)) {
        alreadyOpenScopes.push(...data.open);
        for (let c of data.close) {
          removeLastOccurrenceOf(alreadyOpenScopes, c);
        }
        continue;
      } else if (point.isGreaterThan(to)) {
        continue;
      }

      let bundle = {
        closeScopeIds: [...data.close],
        openScopeIds: [...data.open]
      };

      boundaries = boundaries.insert(point, bundle);
    }

    return [boundaries, alreadyOpenScopes];
  }

  buildHighlightIterator() {
    if (this.tree) {
      return new LayerHighlightIterator(this, this.tree);
    } else {
      return new NullLayerHighlightIterator();
    }
  }

  handleTextChange(edit) {
    const {
      startPosition,
      oldEndPosition,
      newEndPosition
    } = edit;

    if (this.tree) {
      this.tree.edit(edit);
      if (this.editedRange) {
        if (startPosition.isLessThan(this.editedRange.start)) {
          this.editedRange.start = startPosition;
        } if (oldEndPosition.isLessThan(this.editedRange.end)) {
          this.editedRange.end = newEndPosition.traverse(
            this.editedRange.end.traversalFrom(oldEndPosition)
          );
        } else {
          this.editedRange.end = newEndPosition;
        }
      } else {
        this.editedRange = new Range(startPosition, newEndPosition);
      }
    }
  }

  update(nodeRangeSet) {
    // Any update within the layer invalidates our cached fold boundary tree.
    // Updates _outside_ of the layer will not require us to clear this data,
    // because the base `isFoldableCache` is able to figure out how those
    // changes affect the buffer and adjust accordingly. Hence there isn't much
    // of a risk of using stale data in these scenarios.
    if (this.foldResolver) { this.foldResolver.reset(); }

    // Practically speaking, updates that affect _only this layer_ will happen
    // synchronously, because we've made sure not to call this method until the
    // root grammar's tree-sitter parser has been loaded. But we can't load any
    // potential injection layers' languages because we don't know which ones
    // we'll need until we parse this layer's tree for the first time.
    //
    // Thus the first call to `_populateInjections` will probably go async
    // while we wait for the injections' parsers to load, and the user might
    // notice the delay. But once that happens, all subsequent updates _should_
    // be synchronous, except for a case where a change in the buffer causes us
    // to need a new kind of injection whose parser hasn't yet been loaded.
    return this._performUpdate(nodeRangeSet);
  }

  getLocalReferencesAtPoint(point) {
    if (!this.localsQuery) { return []; }
    let captures = this.localsQuery.captures(
      this.tree.rootNode,
      point,
      point + 1
    );

    captures = captures.filter(cap => {
      if (cap.name !== 'local.reference') { return false; }
      if (!rangeForNode(cap.node).containsPoint(point)) {
        return false;
      }
      return true;
    });

    let nodes = captures.map(cap => cap.node);
    nodes = nodes.sort((a, b) => {
      return rangeForNode(b).compare(rangeForNode(a));
    });

    return nodes;
  }

  // EXPERIMENTAL: Given a local reference node, tries to find the node that
  // defines it.
  findDefinitionForLocalReference(node, captures = null) {
    let name = node.text;
    if (!name) { return []; }
    let localRange = rangeForNode(node);
    let globalScope = this.tree.rootNode;

    if (!captures) {
      captures = this.groupLocalsCaptures(
        this.localsQuery.captures(
          globalScope,
          globalScope.startPosition,
          globalScope.endPosition
        )
      );
    }

    let { scopes, definitions } = captures;

    // Consider only the scopes that can influence our local node.
    let relevantScopes = scopes.filter((scope) => {
      let range = rangeForNode(scope);
      return range.containsRange(localRange);
    }).sort((a, b) => a.compare(b));

    relevantScopes.push(globalScope);

    // Consider only the definitions whose names match the target's.
    let relevantDefinitions = definitions.filter(
      (def) => def.text === name
    );
    if (relevantDefinitions.length === 0) { return []; }

    let definitionsByBaseScope = new Index();
    for (let rDef of relevantDefinitions) {
      // Find all the scopes that include this definition. The largest of those
      // scopes will be its "base" scope. If there are no scopes that include
      // this definition, it must have been defined globally.
      let rDefScopes = scopes.filter(s => {
        return isBetweenPoints(
          rDef.startPosition,
          s.startPosition,
          s.endPosition
        );
      }).sort((a, b) => {
        return rangeForNode(b).compare(rangeForNode(a));
      });

      let baseScope = rDefScopes[0] ?? globalScope;

      // Group each definition by its scope. Since any variable can be
      // redefined an arbitrary number of times, each scope might include
      // multiple definitions of this identifier.
      definitionsByBaseScope.add(baseScope, rDef);
    }

    // Moving from smallest to largest scope, get definitions that were made in
    // that scope, and return the closest one to the reference.
    for (let scope of relevantScopes) {
      let definitionsInScope = definitionsByBaseScope.get(scope) ?? [];
      let { length } = definitionsInScope;
      if (length === 0) { continue; }
      if (length === 1) { return definitionsInScope[0]; }

      // Here's how we want to sort these candidates:
      //
      // * In each scope, look for a definitions that happen before the local's
      //   position. The closest such definition in the narrowest scope is our
      //   ideal target.
      // * Failing that, take note of all the definitions that happened _after_
      //   the local's position in all relevant scopes. Choose the closest to
      //   the local.
      //
      let definitionsBeforeLocal = [];
      let definitionsAfterLocal = [];

      for (let def of definitionsInScope) {
        let result = comparePoints(def.startPosition, localRange.start);

        let bucket = result < 0 ?
          definitionsBeforeLocal :
          definitionsAfterLocal;

        bucket.push(def);
      }

      if (definitionsBeforeLocal.length > 0) {
        let maxBeforeLocal;
        for (let def of definitionsBeforeLocal) {
          if (!maxBeforeLocal) {
            maxBeforeLocal = def;
            continue;
          }

          let result = comparePoints(def, maxBeforeLocal);
          if (result > 0) {
            maxBeforeLocal = def;
          }
        }
        return maxBeforeLocal;
      }

      // TODO: For definitions that happen after the local in the buffer, it's
      // not 100% clear what the right answer should be. I imagine it varies by
      // language. Best guess for now is the one that's closest to the local
      // reference.
      let minAfterLocal;
      for (let def of definitionsAfterLocal) {
        if (!minAfterLocal) {
          minAfterLocal = def;
          continue;
        }

        let result = comparePoints(def, minAfterLocal);
        if (result < 0) {
          minAfterLocal = def;
        }
      }

      return minAfterLocal;
    }
  }

  groupLocalsCaptures(captures) {
    let scopes = [];
    let definitions = [];
    let references = [];

    for (let capture of captures) {
      let { name, node } = capture;
      switch (name) {
        case 'local.scope':
          scopes.push(node);
          break;
        case 'local.definition':
          definitions.push(node);
          break;
        case 'local.reference':
          references.push(node);
          break;
      }
    }

    return { scopes, definitions, references };
  }

  updateInjections(grammar) {
    // This method is called when a random grammar in the registry has been
    // added or updated, so we only care about it if it could possibly affect
    // an injection of ours.
    if (!grammar?.injectionRegex) { return; }

    // We don't need to consume the grammar itself; we'll just call
    // `_populateInjections` here because the callback signals that this
    // layer's list of injection points might have changed.
    this._populateInjections(MAX_RANGE, null);
  }

  async _performUpdate(nodeRangeSet) {
    await this.languageLoaded;
    let includedRanges = null;
    if (nodeRangeSet) {
      includedRanges = nodeRangeSet.getRanges(this.languageMode.buffer);
      if (includedRanges.length === 0) {
        const range = this.marker.getRange();
        this.destroy();
        this.languageMode.emitRangeUpdate(range);
        return;
      }
    }

    let affectedRange = this.editedRange;
    this.editedRange = null;

    let language = this.grammar.getLanguageSync();
    let tree = this.languageMode.parse(
      language,
      this.tree,
      includedRanges
    );

    this.currentNodeRangeSet = includedRanges;

    if (this.tree) {
      const rangesWithSyntaxChanges = this.tree.getChangedRanges(tree);
      this.tree = tree;

      if (rangesWithSyntaxChanges.length > 0) {
        for (const range of rangesWithSyntaxChanges) {
          this.languageMode.emitRangeUpdate(rangeForNode(range));
        }

        const combinedRangeWithSyntaxChange = new Range(
          rangesWithSyntaxChanges[0].startPosition,
          last(rangesWithSyntaxChanges).endPosition
        );

        if (affectedRange) {
          this.languageMode.emitRangeUpdate(affectedRange);
          affectedRange = affectedRange.union(combinedRangeWithSyntaxChange);
        } else {
          affectedRange = combinedRangeWithSyntaxChange;
        }
      }
    } else {
      this.tree = tree;

      // Like legacy tree-sitter, we're patching syntax nodes so that they have
      // a `range` property that returns a `Range`. We're doing this for
      // compatibility, but we can't get a reference to the node class itself;
      // we have to wait until we have an instance and grab the prototype from
      // there.
      //
      // This is the earliest place in the editor lifecycle where we're
      // guaranteed to be holding an instance of `Node`. Once we patch it here,
      // we're good to go.
      //
      ensureRangePropertyIsDefined(tree.rootNode);

      this.languageMode.emitRangeUpdate(rangeForNode(tree.rootNode));
      if (includedRanges) {
        affectedRange = new Range(
          includedRanges[0].startPosition,
          last(includedRanges).endPosition
        );
      } else {
        affectedRange = MAX_RANGE;
      }
    }

    if (affectedRange) {
      await this._populateInjections(affectedRange, nodeRangeSet);
    }
  }

  forceAnonymousParse() {
    return this.languageMode.parse(this.language, this.tree, this.currentNodeRangeSet);
  }

  getText() {
    let { buffer } = this.languageMode;
    if (!this.marker) {
      return buffer.getText();
    } else {
      return buffer.getTextInRange(this.marker.getRange());
    }
  }

  getFolds() {
    if (!this.foldsQuery) { return []; }
    let foldsTree = this.forceAnonymousParse();
    return this.foldsQuery.captures(foldsTree.rootNode);
  }

  // Given a point, return all syntax captures that are active at that point.
  // Used by `scopeDescriptorForPosition` and `bufferRangeForScopeAtPosition`.
  scopeMapAtPosition(point) {
    if (!this.language || !this.tree) { return []; }
    let { scopeResolver } = this;
    scopeResolver.reset();

    // If the cursor is resting before column X, we want all scopes that cover
    // the character in column X.
    let captures = this.syntaxQuery.captures(
      this.tree.rootNode,
      point,
      { row: point.row, column: point.column + 1 }
    );

    let results = [];
    for (let capture of captures) {
      // Storing the capture will return its range (after any potential
      // adjustments) — or `false`, to signify that the capture was ignored.
      let range = scopeResolver.store(capture);
      if (!range) { continue; }

      // Since the range might have been adjusted, we wait until after resolution
      if (comparePoints(range.endPosition, point) === 0) { continue; }
      if (isBetweenPoints(point, range.startPosition, range.endPosition)) {
        results.push(capture);
      }
    }

    scopeResolver.reset();

    // Sort from biggest to smallest.
    results = results.sort((a, b) => {
      return nodeBreadth(b) - nodeBreadth(a);
    });

    return results;
  }

  // Like `WASMTreeSitterLanguageMode#getSyntaxNodeAtPosition`, but for just this
  // layer.
  getSyntaxNodeAtPosition(position, where = FUNCTION_TRUE) {
    if (!this.language || !this.tree) { return null; }
    let { buffer } = this.languageMode;

    let index = buffer.characterIndexForPosition(position);
    let node = this.tree.rootNode.descendantForIndex(index);

    while (node) {
      if (where(node, this.grammar)) {
        return node;
      }
      node = node.parent;
    }

    return null;
  }

  _populateInjections (range, nodeRangeSet) {
    const promises = [];
    let existingInjectionMarkers = this.languageMode.injectionsMarkerLayer
      .findMarkers({ intersectsRange: range })
      .filter(marker => marker.parentLanguageLayer === this);

    if (existingInjectionMarkers.length > 0) {
      range = range.union(
        new Range(
          existingInjectionMarkers[0].getRange().start,
          last(existingInjectionMarkers).getRange().end
        )
      );
    }

    const markersToUpdate = new Map();
    const nodes = this.tree.rootNode.descendantsOfType(
      Object.keys(this.grammar.injectionPointsByType),
      range.start,
      range.end
    );

    let existingInjectionMarkerIndex = 0;
    for (const node of nodes) {
      for (const injectionPoint of this.grammar.injectionPointsByType[node.type]) {
        const languageName = injectionPoint.language(node);
        if (!languageName) { continue; }

        const grammar = this.languageMode.grammarForLanguageString(
          languageName
        );
        if (!grammar) { continue; }

        const contentNodes = injectionPoint.content(node);
        if (!contentNodes) { continue; }

        const injectionNodes = [].concat(contentNodes);
        if (!injectionNodes.length) continue;

        const injectionRange = node.range;

        let marker;

        for (
          let i = existingInjectionMarkerIndex,
            n = existingInjectionMarkers.length;
          i < n;
          i++
        ) {
          const existingMarker = existingInjectionMarkers[i];
          const comparison = existingMarker.getRange().compare(injectionRange);
          if (comparison > 0) {
            break;
          } else if (comparison === 0) {
            existingInjectionMarkerIndex = i;
            if (existingMarker.languageLayer.grammar === grammar) {
              marker = existingMarker;
              break;
            }
          } else {
            existingInjectionMarkerIndex = i;
          }
        }

        if (!marker) {
          marker = this.languageMode.injectionsMarkerLayer.markRange(
            injectionRange
          );

          marker.languageLayer = new LanguageLayer(
            marker,
            this.languageMode,
            grammar,
            this.depth + 1,
            injectionPoint
          );

          marker.parentLanguageLayer = this;
        }

        markersToUpdate.set(
          marker,
          new NodeRangeSet(
            nodeRangeSet,
            injectionNodes,
            injectionPoint.newlinesBetween,
            injectionPoint.includeChildren
          )
        );
      }
    }

    for (const marker of existingInjectionMarkers) {
      if (!markersToUpdate.has(marker)) {
        this.languageMode.emitRangeUpdate(
          marker.getRange()
        );
        marker.languageLayer.destroy();
      }
    }

    if (markersToUpdate.size > 0) {
      for (const [marker, nodeRangeSet] of markersToUpdate) {
        promises.push(marker.languageLayer.update(nodeRangeSet));
      }
    }

    return Promise.all(promises);
  }
}

// An injection `LanguageLayer` may need to parse and highlight a strange
// subset of its stated range — for instance, all the descendants within a
// parent that are of a particular type. A `NodeRangeSet` is how that strange
// subset is expressed.
class NodeRangeSet {
  constructor(previous, nodes, newlinesBetween, includeChildren) {
    this.previous = previous;
    this.nodes = nodes;
    this.newlinesBetween = newlinesBetween;
    this.includeChildren = includeChildren;
  }

  getRanges(buffer) {
    const previousRanges = this.previous && this.previous.getRanges(buffer);
    const result = [];

    for (const node of this.nodes) {
      let position = node.startPosition, index = node.startIndex;

      if (!this.includeChildren) {
        // If `includeChildren` is `false`, we're effectively collecting all
        // the disjoint text nodes that are direct descendants of this node.
        for (const child of node.children) {
          const nextIndex = child.startIndex;
          if (nextIndex > index) {
            this._pushRange(buffer, previousRanges, result, {
              startIndex: index,
              endIndex: nextIndex,
              startPosition: position,
              endPosition: child.startPosition
            });
          }
          position = child.endPosition;
          index = child.endIndex;
        }
      }

      if (node.endIndex > index) {
        this._pushRange(buffer, previousRanges, result, {
          startIndex: index,
          endIndex: node.endIndex,
          startPosition: position,
          endPosition: node.endPosition
        });
      }
    }

    return result;
  }

  _pushRange(buffer, previousRanges, newRanges, newRange) {
    if (!previousRanges) {
      if (this.newlinesBetween) {
        const { startIndex, startPosition } = newRange;
        this._ensureNewline(buffer, newRanges, startIndex, startPosition);
      }
      newRanges.push(newRange);
      return;
    }

    for (const previousRange of previousRanges) {
      if (previousRange.endIndex <= newRange.startIndex) continue;
      if (previousRange.startIndex >= newRange.endIndex) break;
      const startIndex = Math.max(
        previousRange.startIndex,
        newRange.startIndex
      );
      const endIndex = Math.min(previousRange.endIndex, newRange.endIndex);
      const startPosition = Point.max(
        previousRange.startPosition,
        newRange.startPosition
      );
      const endPosition = Point.min(
        previousRange.endPosition,
        newRange.endPosition
      );
      if (this.newlinesBetween) {
        this._ensureNewline(buffer, newRanges, startIndex, startPosition);
      }
      newRanges.push({ startIndex, endIndex, startPosition, endPosition });
    }
  }

  // For injection points with `newlinesBetween` enabled, ensure that a
  // newline is included between each disjoint range.
  _ensureNewline(buffer, newRanges, startIndex, startPosition) {
    const lastRange = newRanges[newRanges.length - 1];
    if (lastRange && lastRange.endPosition.row < startPosition.row) {
      newRanges.push({
        startPosition: new Point(
          startPosition.row - 1,
          buffer.lineLengthForRow(startPosition.row - 1)
        ),
        endPosition: new Point(startPosition.row, 0),
        startIndex: startIndex - startPosition.column - 1,
        endIndex: startIndex - startPosition.column
      });
    }
  }
}

// Like a map, but expects each key to have multiple values.
class Index extends Map {
  constructor() {
    super();
  }

  add(key, ...values) {
    let existing = this.get(key);
    if (!existing) {
      existing = [];
      this.set(key, existing);
    }
    existing.push(...values);
  }
}

module.exports = WASMTreeSitterLanguageMode;
