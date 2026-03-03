declare module 'encryptjs' {
  const version: string;

  function setKey(key: string): void;
  function decrypt(ciphertext: any, password: any, nBits: any): any;

  function encrypt(plaintext: any, password?: any, nBits?: any): any;

  function getTextEncryptAndSaveToJSONFile(
    filePath: any,
    password: any,
    nBits: any
  ): void;

  function getTextEncryptAndSaveToTextFile(
    filePath: any,
    password: any,
    nBits: any
  ): void;

  function init(): void;

  function writeCipherTextToJSON(
    file: any,
    obj: any,
    options: any,
    callback: any
  ): any;
}
