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

    // Initialize state for assert-divide strategy
    if (sketchType === 'assert_divide') {
      this.outputChannel.appendLine('\n=== Starting new assert-divide operation ===');
      const documentUri = document.uri.toString();
      const currentDiagnostics = this.diagnosticsListener.get(document.uri) || [];
      this.outputChannel.appendLine(`Initial diagnostics count: ${currentDiagnostics.length}`);
      this.assertDivideStates.set(documentUri, {
        attemptedLines: new Set(),
        originalDiagnostics: [...currentDiagnostics]
      });
    }

    // Check if this is an IDE-specific type
    if (sketchType === 'assert_divide') {
      // Handle assert-divide
      window.showInformationMessage('Starting assert-divide');
      const selection = editor.selection;
      
      // Get the current assertion and its context
      const currentLine = editor.document.lineAt(selection.start.line);
      const text = currentLine.text;

      // Check if we're on an assert statement
      if (!text.trim().startsWith("assert")) {
        window.showInformationMessage("Please place cursor on an assert statement");
        return null;
      }

      // Extract the assertion expression
      const assertMatch = text.match(/assert\s+(.*?);/);
      if (!assertMatch) {
        return null;
      }
      const assertion = assertMatch[1];

      // Create a workspace edit to insert intermediate assertions
      const workspaceEdit = new WorkspaceEdit();
      
      // Insert intermediate assertions with a placeholder
      const intermediateAssert = 
          `    // Intermediate step\n` +
          `    assert ${assertion.split(" && ")[0]};\n` +
          `    // Next step\n` +
          `    assert ${assertion};`;
      
      // Insert the new assertions before the current one
      workspaceEdit.insert(
          document.uri,
          new Position(selection.start.line, 0),
          intermediateAssert + '\n'
      );

      // Apply the edit
      await workspace.applyEdit(workspaceEdit);

      // Trigger verification
      await commands.executeCommand(DafnyCommands.Build);

      window.showInformationMessage("Added intermediate assertions. Verifying...");
      return null; // Return null to prevent LSP handling
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