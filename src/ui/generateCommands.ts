import { window, commands, Diagnostic, TextEditor, Position, DiagnosticCollection, languages, OutputChannel, workspace, WorkspaceEdit } from 'vscode';
import { DafnyLanguageClient } from '../language/dafnyLanguageClient';
import { DafnyInstaller } from '../language/dafnyInstallation';
import { DafnyCommands, VSCodeCommands } from '../commands';

interface AssertDivideState {
  attemptedLines: Set<number>;
  originalDiagnostics: Diagnostic[];
  lastGeneratedLine?: number;
}

export default class GenerateCommands {
  private static assertDivideStates = new Map<string, AssertDivideState>();
  private static diagnosticsListener: DiagnosticCollection;
  private static outputChannel: OutputChannel;

  public static createAndRegister(installer: DafnyInstaller, client: DafnyLanguageClient): GenerateCommands {
    this.diagnosticsListener = languages.createDiagnosticCollection('dafny');
    this.outputChannel = window.createOutputChannel('Dafny Assert-Divide');

    installer.context.subscriptions.push(commands.registerCommand(
      DafnyCommands.GenerateSketch,
      (args?: { sketchType: string }) => GenerateCommands.CreateCommand(client, args?.sketchType)));

    // Listen for diagnostic updates
    installer.context.subscriptions.push(
      languages.onDidChangeDiagnostics(() => {
        this.outputChannel.appendLine('Diagnostics changed, handling...');
        this.handleDiagnosticsChange(client);
      })
    );

    return new GenerateCommands();
  }

  private static async handleDiagnosticsChange(client: DafnyLanguageClient) {
    const editor = window.activeTextEditor;
    if (!editor) {
      this.outputChannel.appendLine('No active editor, skipping diagnostic handling');
      return;
    }

    const documentUri = editor.document.uri.toString();
    const state = this.assertDivideStates.get(documentUri);
    if (!state) {
      this.outputChannel.appendLine('No assert-divide state for current document, skipping');
      return;
    }

    const currentDiagnostics = this.diagnosticsListener.get(editor.document.uri) || [];
    this.outputChannel.appendLine(`Original diagnostics count: ${state.originalDiagnostics.length}`);
    this.outputChannel.appendLine(`Current diagnostics count: ${currentDiagnostics.length}`);
    
    if (currentDiagnostics.length >= state.originalDiagnostics.length) {
      this.outputChannel.appendLine('No improvement in diagnostics, trying next assertion...');
      await this.tryNextAssertion(client, editor, state);
    } else {
      this.outputChannel.appendLine('Diagnostics improved!');
    }
  }

  private static async tryNextAssertion(
    client: DafnyLanguageClient, 
    editor: TextEditor, 
    state: AssertDivideState
  ) {
    this.outputChannel.appendLine('Trying to find next assertion point...');
    this.outputChannel.appendLine(`Current attempted lines: ${[...state.attemptedLines].join(', ')}`);
    this.outputChannel.appendLine(`Last generated line: ${state.lastGeneratedLine}`);

    // Find a gap between verified lines to insert an assert
    const nextLine = this.findNextAssertLine(editor, state);
    if (nextLine === null) {
      this.outputChannel.appendLine('No more gaps to try, ending assert-divide');
      this.assertDivideStates.delete(editor.document.uri.toString());
      return;
    }

    this.outputChannel.appendLine(`Found next line for assertion: ${nextLine}`);
    state.lastGeneratedLine = nextLine;
    state.attemptedLines.add(nextLine);

    // Generate assert at this line
    this.outputChannel.appendLine('Generating assertion...');
    await this.generateAssertAtLine(client, editor, nextLine);
  }

  private static async handleAssertDivide(editor: TextEditor, document: any): Promise<any> {
    this.outputChannel.appendLine('\n=== Starting new assert-divide operation ===');
    window.showInformationMessage('Starting assert-divide');
    
    const assertInfo = await this.extractAssertInfo(editor);
    if (!assertInfo) {
      return null;
    }

    // Store initial state for verification feedback
    const documentUri = document.uri.toString();
    const currentDiagnostics = this.diagnosticsListener.get(document.uri) || [];
    this.outputChannel.appendLine(`Initial diagnostics count: ${currentDiagnostics.length}`);
    this.assertDivideStates.set(documentUri, {
      attemptedLines: new Set([assertInfo.line]),
      originalDiagnostics: [...currentDiagnostics]
    });

    await this.insertIntermediateAssertions(document, assertInfo);
    await this.triggerVerification();

    window.showInformationMessage("Added intermediate assertions. Verifying...");
    return null;
  }

  private static async extractAssertInfo(editor: TextEditor): Promise<{line: number, assertion: string} | null> {
    const selection = editor.selection;
    const currentLine = editor.document.lineAt(selection.start.line);
    const text = currentLine.text;

    if (!text.trim().startsWith("assert")) {
      window.showInformationMessage("Please place cursor on an assert statement");
      return null;
    }

    const assertMatch = text.match(/assert\s+(.*?);/);
    if (!assertMatch) {
      return null;
    }

    return {
      line: selection.start.line,
      assertion: assertMatch[1]
    };
  }

  private static async insertIntermediateAssertions(document: any, assertInfo: {line: number, assertion: string}): Promise<void> {
    const workspaceEdit = new WorkspaceEdit();
    
    // For now, simple && splitting. Later we can make this smarter based on verification feedback
    const intermediateAssert = 
        `    // Intermediate step\n` +
        `    assert ${assertInfo.assertion.split(" && ")[0]};\n` +
        `    // Next step\n` +
        `    assert ${assertInfo.assertion};`;
    
    workspaceEdit.insert(
        document.uri,
        new Position(assertInfo.line, 0),
        intermediateAssert + '\n'
    );

    await workspace.applyEdit(workspaceEdit);
  }

  private static async triggerVerification(): Promise<void> {
    await commands.executeCommand(DafnyCommands.Build);
  }

  private static findNextAssertLine(editor: TextEditor, state: AssertDivideState): number | null {
    const startLine = state.lastGeneratedLine || 0;
    const endLine = editor.document.lineCount;
    const midLine = Math.floor((startLine + endLine) / 2);

    this.outputChannel.appendLine(`Searching for gap: start=${startLine}, end=${endLine}, mid=${midLine}`);

    if (state.attemptedLines.has(midLine) || midLine === startLine) {
      this.outputChannel.appendLine('No suitable gap found');
      return null;
    }

    return midLine;
  }

  private static async generateAssertAtLine(
    client: DafnyLanguageClient,
    editor: TextEditor,
    line: number
  ) {
    this.outputChannel.appendLine(`Generating assert at line ${line}`);
    const position = new Position(line, 0);
    await client.generateSketch({
      prompt: undefined,
      sketchType: 'assert_divide',
      position: position,
      textDocument: { uri: editor.document.uri.toString() },
      content: editor.document.getText()
    });
  }

  private static async CreateCommand(client: DafnyLanguageClient, preselectedType?: string) {
    const sketchType = preselectedType ?? await (async () => {
      const sketchTypes = await client.getSketchTypes();
      return window.showQuickPick(sketchTypes, {
        placeHolder: 'Select a sketch type',
        canPickMany: false
      });
    })();

    if(sketchType == null) {
      return null;
    }

    let prompt = undefined;
    if(sketchType === 'ai') {
      prompt = await window.showInputBox({
        prompt: 'Enter your AI prompt',
        placeHolder: 'Describe what you want to generate'
      });
    }

    const editor = window.activeTextEditor;
    if(editor == null) {
      window.showInformationMessage('editor is null');
      return null;
    }
    const document = editor.document;
    const content = document.getText();
    const position = editor.selection.active;
    if(document == null) {
      window.showInformationMessage('document is null');
      return null;
    }
    if(document.isUntitled) {
      window.showInformationMessage('document is untitled');
      commands.executeCommand(VSCodeCommands.SaveAs);
      return null;
    }


    // Check if this is an IDE-specific type
    if (sketchType === 'assert_divide') {
      return await this.handleAssertDivide(editor, document);

    }

    // Otherwise, pass to server as normal
    return client.generateSketch({ 
      prompt: prompt,
      content: content, 
      sketchType: sketchType, 
      position: position,
      textDocument: { uri: document.uri!.toString() }
    });
  }
}