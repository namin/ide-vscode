import { window, commands } from 'vscode';
import { DafnyLanguageClient } from '../language/dafnyLanguageClient';

import { DafnyInstaller } from '../language/dafnyInstallation';
import { DafnyCommands, VSCodeCommands } from '../commands';

import { SketchType } from '../language/api/proofSketchParams';

export default class GenerateCommands {
  private static readonly map: { [key: string]: SketchType } = {
    [DafnyCommands.GenerateInductiveProofSketch]: SketchType.Inductive,
    [DafnyCommands.GenerateConditionAssertionProofSketch]: SketchType.Assertions
  };
  public static createAndRegister(installer: DafnyInstaller, client: DafnyLanguageClient): GenerateCommands {
    for(const [ name, type ] of Object.entries(GenerateCommands.map)) {
      GenerateCommands.RegisterCommand(installer, client, name, type);
    }
    return new GenerateCommands();
  }
  private static RegisterCommand(installer: DafnyInstaller, client: DafnyLanguageClient, name: string, type: SketchType) {
    installer.context.subscriptions.push(commands.registerCommand(name,
      () => GenerateCommands.CreateCommand(client, type)));
  }
  private static async CreateCommand(client: DafnyLanguageClient, sketchType: SketchType) {
    const editor = window.activeTextEditor;
    if(editor == null) {
      window.showInformationMessage('editor is null');
      return null;
    }
    const document = editor.document;
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
    //if(!await document.save()) {
    //  return null;
    //}
    return client.generateProofSketch({ sketchType: sketchType, position: position, textDocument: { uri: document.uri!.toString() } });
  }
}