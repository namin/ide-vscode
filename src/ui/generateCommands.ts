import { window, commands, Diagnostic, TextEditor, Position, DiagnosticCollection, languages, OutputChannel, workspace, WorkspaceEdit, Range } from 'vscode';
import { DafnyLanguageClient } from '../language/dafnyLanguageClient';
import { DafnyInstaller } from '../language/dafnyInstallation';
import { DafnyCommands, VSCodeCommands } from '../commands';
import SketchAssertDivide from './sketchAssertDivide';

export default class GenerateCommands {
  private static sketchAssertDivide: SketchAssertDivide;

  public static createAndRegister(installer: DafnyInstaller, client: DafnyLanguageClient): GenerateCommands {
    this.sketchAssertDivide = SketchAssertDivide.createAndRegister(installer, client);
    installer.context.subscriptions.push(commands.registerCommand(
      DafnyCommands.GenerateSketch,
      (args?: { sketchType: string }) => GenerateCommands.CreateCommand(client, args?.sketchType)));

    return new GenerateCommands();
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
    if(sketchType.startsWith('ai')) {
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
    if(sketchType === 'assert_divide') {
      return await SketchAssertDivide.handle(editor, document, client);

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