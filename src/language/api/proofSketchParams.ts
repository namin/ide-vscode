import { TextDocumentPositionParams } from 'vscode-languageclient/node';

export interface IProofSketchParams extends TextDocumentPositionParams {
    sketchType: string;
}