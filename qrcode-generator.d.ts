declare module 'qrcode-generator' {
  const QRCodeGenerator: (typeNumber: number, errorCorrectionLevel: string) => {
    addData(data: string): void
    make(): void
    getModuleCount(): number
    isDark(row: number, column: number): boolean
  }

  export default QRCodeGenerator
}
