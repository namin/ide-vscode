import { TextDocumentPositionParams } from 'vscode-languageclient/node';

export enum SketchType {
    Inductive = 'inductive',
    Assertions = 'assertions'
}

export interface IProofSketchParams extends TextDocumentPositionParams {
    sketchType: SketchType;
}