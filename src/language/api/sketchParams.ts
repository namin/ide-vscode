import { TextDocumentPositionParams } from 'vscode-languageclient/node';

export interface ISketchParams extends TextDocumentPositionParams {
    sketchType: string;
    content: string;
    prompt: string | undefined;
}