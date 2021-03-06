'use strict';

/**
 * AWK Language Server for Visual Studio Code.
 * 
 * This module handles the interaction between the parser and document
 * administration and VSCode. Code based on VSCode examples.
 */

import {
    IPCMessageReader, IPCMessageWriter, createConnection, IConnection, TextDocuments,
    DiagnosticSeverity, InitializeParams, InitializeResult, CompletionItem,
    CompletionItemKind, Location, Range, Position, Definition, Hover,
    SymbolInformation, SymbolKind, ReferenceParams,
    WorkspaceSymbolParams, TextDocumentPositionParams, TextDocument,
    DocumentSymbolParams, DidCloseTextDocumentParams, SignatureHelp,
    CancellationToken, SignatureInformation, ParameterInformation, ResponseError, TextDocumentChangeEvent
} from 'vscode-languageserver';

import {
    parse, setFileBaseName, setDefineFun, setMessageFun, setUsageFun,
    setIncludeFun, updateStylisticWarnings, lastSymbolPos, builtInSymbols,
    BuiltInFunction, AwkLanguageServerSettings, setFunctionCallFun,
    setParameterFun, functionBlocks, FunctionBlock, setRegisterNumberOfParameters, setFileMode
} from "./awk";

import { transitiveClosure } from './util';

import  {
    finishPositionTree, positionCompare
} from './path';

import {
    AWKDocument, IncludeDeclarationInfo
} from './awkdocument';

import {
    SymbolDefinition,
    SymbolUsage,
    SymbolType,
    getRange,
    getSymbolDefineType,
    isSymbolDefineType,
    removeSymbolDefineType,
    ParameterUsage
} from './symbols';

import {
    readFile, makeURI, makeAbsolutePathName, makeRelativePathName,
    fileExists, nrOpenReadRequests
} from './filesystem';

import {
    setDebugLogDir
} from './filesystem';

// PROCESSING QUEUE

enum ProcessQueueItemType {
    awk
}

/** Item to process */
class ProcessQueueItem {
    /** The document holder */
    doc: AWKDocument;
    /** The textual contents of the document */
    text: string;
    /** The type of document */
    type: ProcessQueueItemType;
    /** When true, the file is open in the editor */
    openInEditor: boolean;
}

let processingAllowed: boolean = true;

let processingQueue: ProcessQueueItem[] = [];

function addToEndOfProcessingQueue(doc: AWKDocument, text: string, type: ProcessQueueItemType, openInEditor: boolean): void {
    processingQueue.push({doc: doc, text: text, type: type, openInEditor: openInEditor});
    processNextQueueItem();
}

function processNextQueueItem(): void {
    while (nrOpenReadRequests === 0 && processingAllowed && processingQueue.length !== 0) {
        const queueItem: ProcessQueueItem = processingQueue.shift()!;
        switch (queueItem.type) {
          case ProcessQueueItemType.awk:
            validateTextDocument(queueItem.doc, queueItem.text, queueItem.openInEditor);
            break;
        }
    }
    if (nrOpenReadRequests === 0 && processingAllowed) {
        finishUpProcessing();
    }
}

function sendDiagnostics(): void {
    for (const doc of documentMap.values()) {
        doc.sendDiagnostics(connection, config.maxNumberOfProblems);
    }
}

function finishUpProcessing(): void {
    closeEmptyDocuments();
    semanticAnalysis();
    sendDiagnostics();
}

// LANGUAGE DEFINITION AND USAGE

// CALLBACK FROM THE PARSER

let includePath: string[] = ["."];

function setIncludePath(ip: string[]): boolean {
    if (ip.length === includePath.length &&
          ip.every((value: string, index: number) => includePath[index] === value)) {
        return false;
    }
    includePath = ip;
    return true;
}

// Triggers parsing of an include file, or reports that the file doesn't exist
function addInclude(filename: string, relative: boolean, position: Position, length: number, includeSource: AWKDocument): void {
    const inclFileNames: string[] = relative?
        makeRelativePathName(includeSource.uri, filename): makeAbsolutePathName(filename);
    const inclFileName: string = inclFileNames.filter(function(fn: string): boolean {
        return fileExists(fn);
    })[0];

    // debugLog("addInclude " + filename); // !!!
    if (inclFileName === undefined) {
        includeSource.addParseDiagnostic({
            severity: DiagnosticSeverity.Error,
            range: getRange(position, length),
            message: "no such file: " + filename + " (" + includeSource.uri + ")"
        });
        return;
    }
	const inclURI: string = makeURI(inclFileName);
    if (documentMap.has(inclURI)) {
        // Already parsed
        updateInclude(includeSource, documentMap.get(inclURI)!, getRange(position, length));
        return;
    }
	// Prevent loading multiple times, possibly in a cycle
    const newDoc: AWKDocument = new AWKDocument(inclURI);
	documentMap.set(inclURI, newDoc);
    updateInclude(includeSource, newDoc, getRange(position, length));
    // This will trigger a read once the current file has been parsed
    readFile(inclFileName, function (err: any, data: string): void {
        if (!err) {
            addToEndOfProcessingQueue(newDoc, data, ProcessQueueItemType.awk, false);
        } else {
            processNextQueueItem();
        }
    });
}

// Can be called to add an error or warning message for the document;
// ignores specific warnings
function messageFun(type: string, subType: string, msg: string, position: Position, length: number, doc: AWKDocument): void {
    function ignoreThisMessage(): boolean {
        return type === "warning" &&
               ((subType === "comma" && !config.stylisticWarnings.missingSemicolon) ||
                (subType === "future" && !config.stylisticWarnings.compatibility));
    }
    if (!ignoreThisMessage()) {
        doc.addParseDiagnostic({
            severity: type === "warning"? DiagnosticSeverity.Warning: DiagnosticSeverity.Error,
            range: getRange(position, length),
            message: msg
        });
    }
}

/** Maps docURI -> AWKDocument */
let documentMap: Map<string, AWKDocument> = new Map();

function addSymbolDefinition(type: SymbolType, doc: AWKDocument, scope: SymbolDefinition|undefined, symbol: string, position: Position, docComment: string): SymbolDefinition {
    const symbolDefinition: SymbolDefinition = new SymbolDefinition(
        doc, position, type, docComment, scope, symbol, false);
    const def = doc.addSymbolDefinition(symbol, symbolDefinition);
    const defineType = getSymbolDefineType(type);

    if (defineType !== undefined) {
        addSymbolUsage(defineType, doc, symbol, position);
    }
    return def;
}

// Store symbol usage
function addSymbolUsage(type: SymbolType, doc: AWKDocument, symbol: string, position: Position): void {
    const usage = new SymbolUsage(symbol, type, position);

    if (type === SymbolType.globalVariable && !doc.isSymbolDefined(symbol, type)) {
        // In AWK, global variables can be introduced by naming them, so the first
        // occurence is stored as definition. Jumping to that definition
        // doesn't make sense, so its position is left undefined.
        const symbolDefinition: SymbolDefinition = new SymbolDefinition(
            doc, position, type, "", undefined, symbol, true);
        doc.addSymbolDefinition(symbol, symbolDefinition);
    }
    doc.addSymbolUsage(usage);
}

function updateInclude(includingDoc: AWKDocument, includedDoc: AWKDocument, range: Range): void {
    const inclInfo = new IncludeDeclarationInfo(range);

    includingDoc.addIncludes(includedDoc, inclInfo);
    includedDoc.addIncludedBy(includingDoc, inclInfo);
}

function closeEmptyDocuments(): void {
    let inclChanges: boolean = true;

    while (inclChanges) {
        inclChanges = false;
        for (const [uri, doc] of documentMap) {
            if (!doc.isIncluded()) {
                // debugLog("closing " + uri); // !!!
                if (doc.close(connection)) {
                    inclChanges = true;
                }
                documentMap.delete(uri);
            }
        }
    }
}

// DOCUMENT HANDLING

interface UserPreferences {
    maxNumberOfProblems?: number;
    mode?: string;
    stylisticWarnings?: {
        /** When true, warns for superfluous commas */
        missingSemicolon?: boolean;
        /** When true, warns for gawk features in awk mode */
        compatibility?: boolean;
        /** When true, warns when calling a function with the wrong number of parameters */
        checkFunctionCalls: boolean;
    };
    path?: string[];
}

// Default config
let config: AwkLanguageServerSettings = {
	maxNumberOfProblems: 100,
    gawk: true,
    stylisticWarnings: {
        missingSemicolon: false,
        compatibility: true,
        checkFunctionCalls: true
    }
};

function updateConfiguration(settings: UserPreferences|undefined): boolean {
    let reparse: boolean = false;

    // connection.console.log("config " + JSON.stringify(settings)); // !!!
    if (settings === undefined) {
        return false;
    }
    if (settings.maxNumberOfProblems !== config.maxNumberOfProblems) {
          config.maxNumberOfProblems = settings.maxNumberOfProblems || 100;
        reparse = true;
    }
    const gawkMode = settings.mode === undefined || settings.mode === "gawk";
    if (config.gawk !== gawkMode) {
        config.gawk = gawkMode;
        reparse = true;
    }
    if (settings.stylisticWarnings instanceof Object) {
        if (settings.stylisticWarnings.missingSemicolon !== undefined &&
              settings.stylisticWarnings.missingSemicolon !== config.stylisticWarnings.missingSemicolon) {
            config.stylisticWarnings.missingSemicolon = !!settings.stylisticWarnings.missingSemicolon;
            reparse = true;
        }
        if (settings.stylisticWarnings.compatibility !== undefined &&
              settings.stylisticWarnings.compatibility !== config.stylisticWarnings.compatibility) {
            config.stylisticWarnings.compatibility = !!settings.stylisticWarnings.compatibility;
            reparse = true;
        }
        if (settings.stylisticWarnings.checkFunctionCalls !== undefined &&
              settings.stylisticWarnings.checkFunctionCalls !== config.stylisticWarnings.checkFunctionCalls) {
            config.stylisticWarnings.checkFunctionCalls = !!settings.stylisticWarnings.checkFunctionCalls;
            reparse = true;
        }
        updateStylisticWarnings(config, undefined);
        if (settings.path instanceof Array) {
            if (setIncludePath(settings.path)) {
                reparse = true;
            }
        } else if (typeof(process.env["AWKPATH"]) === "string") {
            if (setIncludePath(process.env["AWKPATH"].split(":"))) {
                reparse = true;
            }
        } else {
            if (setIncludePath(["."])) {
                reparse = true;
            }
        }
    }
    return reparse;
}

// let count: number = 0; // debugging

function getFileAwkMode(text: string): boolean|undefined {
    const match = text.match(/^#!(.*[^a-z])?([a-z]?awk) +-f/);

    return match === null? undefined: match[2] === "gawk";
}

function validateTextDocument(doc: AWKDocument, text: string, openInEditor: boolean): void {
    const baseName: string = doc.uri.replace(/^(.*\/)?([^\/]*)\..*$/, "$2");
    const fileAwkMode = getFileAwkMode(text);
    
    // Set up handlers
    setFileBaseName(baseName.match(/Constants$/)? undefined: baseName);
    setDefineFun(function(type: SymbolType, scope: SymbolDefinition|undefined, symbol: string, line: number, position: number, docComment: string): SymbolDefinition {
        return addSymbolDefinition(type, doc, scope, symbol, {line: line - 1, character: position - 1}, docComment);
    });
    setUsageFun(function(type: SymbolType, scope: SymbolDefinition|undefined, symbol: string, line: number, position: number): void {
        // connection.console.log(`message ${type} ${inherit} ${symbol}`); // !!!
        addSymbolUsage(type, doc, symbol, {line: line - 1, character: position - 1});
    });
    setMessageFun(function(type: string, subType: string, msg: string, line: number, position: number, length: number): void {
        // connection.console.log(`message ${type} ${subType} ${msg}`); // !!!
        messageFun(type, subType, msg, {line: line - 1, character: position - 1}, length, doc);
    });
    setIncludeFun(function(filename: string, relative: boolean, line: number, position: number, length: number): void {
        addInclude(filename, relative, {line: line - 1, character: position - 1}, length, doc);
    });
    // connection.console.log("========");
    setFunctionCallFun(function(start: boolean, line: number, position: number): void {
        doc.registerFunctionCall(start, {line: line - 1, character: position - 1});
    });
    setParameterFun(function(parameterIndex: number, start: boolean, line: number, position: number): void {
        doc.registerFunctionCallParameter(parameterIndex, start, line - 1, position - 1);
        // connection.console.log(`param=${parameterIndex}, start=${start}, line=${line}, positions=${position}`);
    });
    setRegisterNumberOfParameters(function(fn: SymbolDefinition): void {
        doc.registerNumberOfParameters(fn);
    });

    setFileMode(fileAwkMode);
	validateText(doc, text);
}

/** This should be 1 at most; anything higher and one call to validateText
    interrupts another.
**/
let parseLevel: number = 0;

function validateText(doc: AWKDocument, text: string): void {
	if (parseLevel !== 0) {
		connection.console.log("parseLevel = " + parseLevel);
	}
	parseLevel++;

    doc.clear();

    // Parse the text; messages are collected via the above handlers
    try {
        doc.resetAnalysisDiagnostics();
        parse(text);
    } catch (ex) {
        connection.console.error(ex);
        messageFun("error", "exception", "parser crash", {line: lastSymbolPos.line - 1, character: lastSymbolPos.position - 1}, 100, doc);
    }

    finishPositionTree(doc.positionTree);

    // Mark the document for semantic analysis in wrap-up
    alteredDocuments.add(doc);
    // If the definitions in the document changed, all documents that include
    // `doc` must be checked too.
    if (!documentsWithAlteredDefinitions.has(doc) &&
          doc.functionInformationHasChanged()) {
        documentsWithAlteredDefinitions.add(doc);
    }

	parseLevel--;
}

/** Returns exact match in sorted array, or undefined */
function binsearch<A, B>(arr: A[], compareToTarget: (a: A) => number): A|undefined {
    let from: number = 0;
    let to: number = arr.length - 1;

    if (from > to) {
        return undefined;
    }
    while (from < to) {
        const i: number = Math.floor((to + from) / 2);
        const res: number = compareToTarget(arr[i]);
        if (res < 0) {
            from = i + 1;
        } else if (res > 0) {
            to = i - 1;
        } else {
            return arr[i];
        }
    }
    return compareToTarget(arr[from]) === 0? arr[from]: undefined;
}

/**
 * Returns index in `arr` that is <= target in a sorted array; this
 * can be outside the array when the target lies before the first entry or
 * after.
 */
function binsearchIndex<A, B>(arr: A[], compareToTarget: (a: A) => number): number {
    let from: number = 0;
    let to: number = arr.length - 1;

    if (from > to) {
        return -1;
    }
    while (from < to) {
        const i: number = Math.floor((to + from) / 2);
        const res: number = compareToTarget(arr[i]);
        if (res < 0) {
            from = i + 1;
        } else if (res > 0) {
            to = i - 1;
        } else {
            // There can only be one parameter at one precise position
            return i;
        }
    }
    return compareToTarget(arr[from]) > 0? from - 1: from;
}

function findSymbolForPosition(textDocumentPosition: TextDocumentPositionParams): SymbolUsage|undefined {
    const docURI = textDocumentPosition.textDocument.uri;
    const doc = documentMap.get(docURI);
    const pos = textDocumentPosition.position;

    function compareToPos(a: SymbolUsage): number {
        return a.position.line !== pos.line? a.position.line - pos.line:
                pos.character == a.position.character && a.symbol.length === 0? 0:
                pos.character > a.position.character + a.symbol.length? -1:
                pos.character < a.position.character? 1:
                0;
    }

    if (doc === undefined) {
        // connection.console.log(`cannot find position`);
        return undefined;
    } else {
        const usage = binsearch(doc.usedSymbols, compareToPos);
        if (usage !== undefined && isSymbolDefineType(usage.type)) {
            return new SymbolUsage(usage.symbol, removeSymbolDefineType(usage.type),
                                   usage.position);
        } else {
            return usage;
        }
    }
}

/**
 * Returns the parameter at the given position or undefined between calls
 * 
 * @param doc Document in which to search
 * @param textDocumentPosition position of the cursor
 */
function findParameterUsage(doc: AWKDocument, textDocumentPosition: TextDocumentPositionParams): ParameterUsage|undefined {
    const pos = textDocumentPosition.position;

    if (doc === undefined) {
        return undefined;
    }
    let firstIndex = binsearchIndex(doc.parameterUsage, (a) => positionCompare(a.position, pos));
    if (firstIndex === -1) {
        return undefined;
    }
    if (doc.parameterUsage[firstIndex].parameterIndex === -1 &&
          positionCompare(doc.parameterUsage[firstIndex].position, pos) < 0) {
        // Reject if it follows the final parameter position
        return undefined;
    }
    while (firstIndex > 0 &&
           positionCompare(doc.parameterUsage[firstIndex].position,
                           doc.parameterUsage[firstIndex - 1].position) === 0) {
        firstIndex--;
    }
    return doc.parameterUsage[firstIndex];
}

function builtInCompletions(textDocumentPosition: TextDocumentPositionParams): CompletionItem[] {
    return Object.keys(builtInSymbols).map(bif => {
        return {
                label: bif,
                kind: CompletionItemKind.Function,
                data: {
                    symbol: bif,
                    docComment: builtInSymbols[bif].description
                }
            }
    });
}

const docCommentStart = /^##[ \t]*/;

/**
 * Strips the leading comment symbols and spaces from `docComment`
 * 
 * @param {string} docComment the docComment string
 * @returns {string} comment without the extra indentation
 */
function leftAlign(docComment: string): string {
    const lines = docComment.split("\n");
    const minLength = lines.map((line) => {
        const matches = line.match(docCommentStart);
        return matches === null? 2: matches[0].length;
    }).reduce((min: number, len: number) => len < min? len: min, 2);

    return lines.map((line: string): string => line.substr(minLength)).join("\n");
}

// LANGUAGE FEATURES

function findFunctionBlock(pos: Position): FunctionBlock|undefined {
    let fbIndex = binsearchIndex(functionBlocks, (a) => positionCompare(a.start, pos));

    return fbIndex >= 0 && fbIndex < functionBlocks.length &&
           functionBlocks[fbIndex].end !== undefined &&
           positionCompare(functionBlocks[fbIndex].start, pos) < 0 &&
           positionCompare(functionBlocks[fbIndex].end!, pos) > 0?
           functionBlocks[fbIndex]: undefined;
}

// Finds symbol to be completed and returns all symbols with a corresponding
// definition.
function awkCompletionHandler(textDocumentPosition: TextDocumentPositionParams): CompletionItem[] {
    const compl = builtInCompletions(textDocumentPosition);
    const fb = findFunctionBlock(textDocumentPosition.position);
    const fbScope = fb === undefined? undefined: fb.functionSymbol;

    let completions: Map<string, Set<string>> = new Map();
    documentMap.forEach(function(doc: AWKDocument): void {
        for (var type = 0; type < doc.definedSymbols.length; type++) {
            const defMap = doc.definedSymbols[type];
            if (defMap !== undefined) {
                defMap.forEach(function(definitions: SymbolDefinition[], symbol: string): void {
                    if (symbol !== undefined /*&& symbol.startsWith(usage!.symbol)*/) {
                        for (let i = 0; i < definitions.length; i++) {
                            const def = definitions[i];
                            if (def.scope === fbScope || def.scope === undefined) {
                                if (!completions.has(symbol)) {
                                    completions.set(symbol, new Set());
                                }
                                if (def.docComment !== undefined && def.docComment !== "") {
                                    completions.get(symbol)!.add(leftAlign(def.docComment));
                                }
                            }
                        }
                    }
                });
            }
        }
    });
    let ci: CompletionItem[] = [];
    completions.forEach(function(docComments: Set<string>, symbol: string): void {
        if (docComments.size === 0) {
            ci.push({
                label: symbol,
                kind: SymbolKind.Interface,
                data: {
                    symbol: symbol
                }
            });
        } else {
            docComments.forEach(function(docComment: string): void {
                ci.push({
                    label: symbol,
                    kind: SymbolKind.Interface,
                    data: {
                        symbol: symbol,
                        docComment: docComment
                    }
                });
            });
        }
    });
    return ci.concat(compl);
}

function makeBuiltInHover(descr: BuiltInFunction): string {
    return descr.parameters === undefined? "built-in variable: " + descr.description:
           "built-in function: " + descr.name + "(" +
           descr.parameters.map((param, i) => i >= descr.firstOptional!? param + "?": param).join(",") +
           "):\n\n" + descr.description;
}

function awkHoverProvider(textDocumentPosition: TextDocumentPositionParams): Hover {
    const usage = findSymbolForPosition(textDocumentPosition);
    const doc = documentMap.get(textDocumentPosition.textDocument.uri);
    const fb = findFunctionBlock(textDocumentPosition.position);
    const fbScope = fb === undefined? undefined: fb.functionSymbol;

	if (doc === undefined || usage === undefined) {
        return { contents: [] };
    } else if (usage.type === SymbolType.func && usage.symbol in builtInSymbols &&
               (config.stylisticWarnings.compatibility || builtInSymbols[usage.symbol].awk)) {
        return {
            contents: [
                makeBuiltInHover(builtInSymbols[usage.symbol])
            ]
        }
    } else if (usage.type === SymbolType.globalVariable && usage.symbol in builtInSymbols &&
               (config.stylisticWarnings.compatibility || builtInSymbols[usage.symbol].awk)) {
        return {
            contents: [
                makeBuiltInHover(builtInSymbols[usage.symbol])
            ]
        }
    }
    let hoverTexts: string[] = [];
    documentMap.forEach(function(doc: AWKDocument): void {
        const defMap: Map<string, SymbolDefinition[]> = doc.definedSymbols[usage!.type];
        if (defMap !== undefined && defMap.has(usage!.symbol)) {
            const definitions = defMap.get(usage!.symbol)!;
            for (let i = 0; i < definitions.length; i++) {
                const def = definitions[i];
                if (def.scope === fbScope || def.scope === undefined) {
                    let text: string|undefined;
                    switch (def.type) {
                       case SymbolType.globalVariable:
                        text = "global variable";
                        break;
                      case SymbolType.localVariable:
                        text = "local variable";
                        break;
                      case SymbolType.parameter:
                        text = "function parameter";
                        break;
                      case SymbolType.func:
                        const name = def.symbol;
                        text = "function " + name + "(" +
                            (def.parameters === undefined? "":
                            def.parameters.map(paramDef => paramDef.symbol).join(", ")
                            ) + ")";
                        break;
                    }
                    if (def.docComment !== undefined) {
                        if (text !== undefined) {
                            text += "\n\n" + leftAlign(def.docComment);
                        } else {
                            text = leftAlign(def.docComment);
                        }
                    }
                    if (text !== undefined) {
                        hoverTexts.push(text);
                    }
                }
            }
        }
    });
	return hoverTexts.length === 0 && usage.type === SymbolType.func? {
            contents: ["undeclared function"]
        }: hoverTexts.length === 0 && usage.type === SymbolType.globalVariable? {
            contents: ["global variable"]
        }: {
		    contents: hoverTexts
        };
}

function awkDefinitionProvider(textDocumentPosition: TextDocumentPositionParams): Definition {
    const usage = findSymbolForPosition(textDocumentPosition);
    const doc = documentMap.get(textDocumentPosition.textDocument.uri);

    if (doc === undefined || usage === undefined) {
        return [];
    }
    const symbol: string = usage.symbol;
    let definitionDistance: SymbolDefinition[] = [];
    documentMap.forEach(function(doc: AWKDocument): void {
        const defMap: Map<string, SymbolDefinition[]> = doc.definedSymbols[usage!.type];
        if (defMap !== undefined && defMap.has(symbol)) {
            const definitions = defMap.get(symbol)!;
            for (let i = 0; i < definitions.length; i++) {
                const def = definitions[i];
                if (!def.isImplicitDefinition) {
                    definitionDistance.push(def);
                }
            }
        }
    });
    return definitionDistance.map((def): Location => 
                Location.create(def.document.uri,
                                getRange(def.position, symbol.length)));
}

function awkListAllSymbolsInFile(params: DocumentSymbolParams/*textDocumentIdentifier: TextDocumentIdentifier*/): SymbolInformation[] {
    const doc = documentMap.get(params.textDocument.uri);

    if (doc === undefined) {
        return [];
    }
    let si: SymbolInformation[] = [];
    doc.definedSymbols.forEach(function(defMap: Map<string, SymbolDefinition[]>, type: SymbolType): void {
        defMap.forEach(function(defs: SymbolDefinition[], symbol: string): void {
            if (symbol !== undefined && defs !== undefined && defs.length > 0) {
                const def: SymbolDefinition = defs[0];
                if (removeSymbolDefineType(def.type) === SymbolType.func) {
                    si.push(SymbolInformation.create(symbol, SymbolKind.Function,
                                                    getRange(def.position, symbol.length)));
                }
            }
        });
    });
    return si;
}

function awkReferenceProvider(rp: ReferenceParams): Location[] {
    const includeDeclaration = rp.context.includeDeclaration;
    const usage = findSymbolForPosition(rp);

    if (usage === undefined) {
        return [];
    }
    let locs: Location[] = [];
    if (includeDeclaration) {
        documentMap.forEach(function(doc: AWKDocument): void {
            const defMap: Map<string, SymbolDefinition[]> = doc.definedSymbols[usage!.type];
            if (defMap !== undefined && defMap.has(usage!.symbol)) {
                const defs = defMap.get(usage!.symbol)!;
                for (let i = 0; i < defs.length; i++) {
                    locs.push(Location.create(doc.uri, defs[i].getRange()));
                }
            }
        });
    }
    documentMap.forEach(function(doc: AWKDocument): void {
        const symbolUsage = doc.usedSymbols;
        for (let i = 0; i < symbolUsage.length; i++) {
            const docUsage = symbolUsage[i];
            if (docUsage.symbol === usage!.symbol &&
                  docUsage.type === usage!.type) {
                locs.push(Location.create(doc.uri, docUsage.getRange()));
            }
        }
    });
    return locs;
}

function awkWorkspaceSymbolProvider(ws: WorkspaceSymbolParams): SymbolInformation[] {
    const query: string = ws.query;
    let si: SymbolInformation[] = [];

    documentMap.forEach(function(doc: AWKDocument): void {
        doc.definedSymbols.forEach(function(defMap: Map<string, SymbolDefinition[]>, type: SymbolType): void {
            defMap.forEach(function(definitions: SymbolDefinition[], symbol: string): void {
                if (symbol !== undefined && symbol.startsWith(query)) {
                    if (definitions !== undefined) {
                        for (let i = 0; i < definitions.length; i++) {
                            const def = definitions[i];
                            if (removeSymbolDefineType(def.type) === SymbolType.func) {
                                si.push(SymbolInformation.create(symbol, SymbolKind.Function,
                                                                 def.getRange(), doc.uri));
                            }
                        }
                    }
                }
            });
        });
    });
    return si;
}

function awkGetFunctionDefinition(usage: SymbolUsage): SymbolDefinition|undefined {
    const symbol: string = usage.symbol;
    let symbolDef: SymbolDefinition|undefined = undefined;

    documentMap.forEach((doc: AWKDocument): void => {
        const defMap: Map<string, SymbolDefinition[]> = doc.definedSymbols[usage.type];
        if (symbolDef === undefined && defMap !== undefined && defMap.has(symbol)) {
            const definitions = defMap.get(symbol)!;
            for (let i = 0; i < definitions.length; i++) {
                if (definitions[i].type === SymbolType.func) {
                    symbolDef = definitions[i];
                    break;
                }
            }
        }
    });
    return symbolDef;
}

function awkSignatureHelper(textDocumentPosition: TextDocumentPositionParams, token: CancellationToken): SignatureHelp|ResponseError<void> {
    var signatures: SignatureInformation[] = [];
    const doc = documentMap.get(textDocumentPosition.textDocument.uri);

    if (doc === undefined) {
        return {
            signatures: signatures,
            activeSignature: null,
            activeParameter: null
        };
    }
    const paramUsage = findParameterUsage(doc, textDocumentPosition);

    if (paramUsage === undefined /* || paramUsage.parameterIndex === -1 */) {
        // connection.console.log(`signature for ${textDocumentPosition.position.line+1},${textDocumentPosition.position.character+1} not found`);
        return {
            signatures: signatures,
            activeSignature: null,
            activeParameter: null
        };
    }
    const funcName = paramUsage.functionName.symbol;
    // connection.console.log(`signature for ${textDocumentPosition.position.line+1},${textDocumentPosition.position.character+1} is ${funcName}`);
    const funcDef: SymbolDefinition|undefined = awkGetFunctionDefinition(paramUsage.functionName);
    if (funcDef !== undefined) {
        const parameters = funcDef.parameters === undefined? []:
                           funcDef.parameters.map(paramDef => paramDef.symbol);
        signatures.push({
            label: funcName + "(" + parameters.join(", ") + ")",
            documentation: funcDef.docComment === ""? undefined: funcDef.docComment,
            parameters: parameters.length === 0? [{label: "no parameters"}]:
                        parameters.map(param => {
                            return {
                                label: param,
                                documentation: param
                            }
                        })
        });
    } else {
        const builtIn = builtInSymbols[funcName];
        if (builtIn === undefined) {
            // should return function definition
            return {
                signatures: [{
                    label: "Undeclared function " + funcName,
                    parameters: [{label: "unknown parameter"}]
                }],
                activeSignature: 0,
                activeParameter: 0
            };
        }
        signatures.push({
            label: funcName + "(" +
                (builtIn.parameters === undefined? "":
                    builtIn.parameters.map((p: string, i: number): string =>
                        builtIn.firstOptional !== undefined && i >= builtIn.firstOptional? p + "?": p
                    ).join(", ")) + ")",
            documentation: builtIn.description,
            parameters: builtIn.parameters === undefined? [{label: "no parameters"}]:
                        builtIn.parameters.map(param => {
                            return {
                                label: param,
                                documentation: param
                            }
                    })
        });
    }
    return {
        signatures: signatures,
        activeSignature: 0,
        activeParameter: Math.max(paramUsage.parameterIndex, 0)
    };
}

let documentsWithAlteredDefinitions: Set<AWKDocument> = new Set<AWKDocument>();
let alteredDocuments: Set<AWKDocument> = new Set<AWKDocument>();

/**
 * Performs check on function calls in all documents in `alteredDocuments` and
 * the documents that include it.
 */
function semanticAnalysis(): void {
    if (config.stylisticWarnings.checkFunctionCalls) {
        // Add documents that include any of the documents in documentsWithAlteredDefinitions
        transitiveClosure(documentsWithAlteredDefinitions, doc => doc.includedBy.keys());
        // Add the documents that were altered themselves (this is a superset
        // of the initial documentsWithAlteredDefinitions, but the documents that
        // include it don't need reanalysis).
        for (const doc of alteredDocuments) {
            documentsWithAlteredDefinitions.add(doc);
        }
        for (const doc of documentsWithAlteredDefinitions) {
            doc.checkFunctionCalls();
        }
        documentsWithAlteredDefinitions.clear();
        alteredDocuments.clear();
    }
}

// Fake reference for the source that includes open documents
let editorURI: string = "editor://";
let editorDocument: AWKDocument = new AWKDocument(editorURI);

function closeDocURI(params: TextDocumentChangeEvent): void {
    const doc = documentMap.get(params.document.uri);

    if (doc !== undefined) {
        doc.removeIncludedBy(editorDocument);
        finishUpProcessing();
    }
}

// INTERFACE TO VSCODE

// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

// After the server has started the client sends an initilize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilites. 
let workspaceRoot: string|null;

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

connection.onInitialize((params: InitializeParams): InitializeResult => {
    // connection.console.log("Initializing server");
    workspaceRoot = params.rootUri;
    setDebugLogDir(workspaceRoot, false);
    // connection.console.log(`server starting: ${process.pid}`); // !!!
    // connection.console.log("server initialized"); // !!!
    return {
        capabilities: {
            // Tell the client that the server works in FULL text document sync mode
            textDocumentSync: documents.syncKind,
            // Tell the client that the server support code complete
            completionProvider: {
                resolveProvider: true
            },
            definitionProvider: true,
            hoverProvider: true,
            documentSymbolProvider: true,
            referencesProvider: true,
            workspaceSymbolProvider: true,
            signatureHelpProvider : {
                triggerCharacters: [ '(' ]
            }
            // signatureHelpProvider?: SignatureHelpOptions;
            // documentHighlightProvider?: boolean;
            // codeActionProvider?: boolean;
            // codeLensProvider?: CodeLensOptions;
            // documentFormattingProvider?: boolean;
            // documentRangeFormattingProvider?: boolean;
            // documentOnTypeFormattingProvider?: DocumentOnTypeFormattingOptions;
            // renameProvider?: boolean;
        }
    }
});

function openTextDocument(uri: string, text: string): void {
    let doc = documentMap.get(uri);
    const type: ProcessQueueItemType = ProcessQueueItemType.awk;

    if (doc === undefined) {
        const inclDeclInfo = new IncludeDeclarationInfo({start: {line: 0, character: 0}, end: {line: 1, character: 0}});
        doc = new AWKDocument(uri);
        doc.addIncludedBy(editorDocument, inclDeclInfo);
        documentMap.set(uri, doc);
    }
    addToEndOfProcessingQueue(doc, text, type, true);
}

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
    openTextDocument(change.document.uri, change.document.getText());
});

documents.onDidClose(closeDocURI);

// The settings interface describe the server relevant settings part
interface Settings {
    awk: AwkLanguageServerSettings;
}

// The settings have changed. Is send on server activation as well.
connection.onDidChangeConfiguration((change) => {
    if (change === undefined) {
        return;
    }
    const settings = <Settings> change.settings;
    if (updateConfiguration(settings.awk)) {
        // Revalidate any open text documents immediately
        documents.all().forEach(function(document: TextDocument): void {
            const doc = documentMap.get(document.uri);
            const type: ProcessQueueItemType = ProcessQueueItemType.awk;
            if (doc !== undefined) {
                addToEndOfProcessingQueue(doc, document.getText(), type, true);
            }
        });
    }
});

/*
connection.onDidChangeWatchedFiles((change) => {
    // Monitored files have change in VSCode
    connection.console.log('We received an file change event');
});
*/

// This handler provides the initial list of the completion items.
connection.onCompletion(awkCompletionHandler);

// This handler resolve additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
    item.detail = item.data.label;
    item.documentation = item.data.docComment;
    return item;
});

// List of all definitions (including docComment) of the symbol at the given position
connection.onHover(awkHoverProvider);

// List of locations of the symbol at the given position sorted by inheritance
// distance.
connection.onDefinition(awkDefinitionProvider);

// List of all definitions in a file
connection.onDocumentSymbol(awkListAllSymbolsInFile);

connection.onReferences(awkReferenceProvider);

connection.onWorkspaceSymbol(awkWorkspaceSymbolProvider);

// connection.onDidOpenTextDocument(params => {
//     openTextDocument(params.textDocument.uri, params.textDocument.text);
// });

// connection.onDidCloseTextDocument(closeDocURI);

connection.onSignatureHelp(awkSignatureHelper);

// Listen on the connection
connection.listen();
