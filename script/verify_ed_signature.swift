import CryptoKit
import Foundation

// Checks a Sparkle EdDSA (ed25519) signature the way the app will:
//   swift script/verify_ed_signature.swift <SUPublicEDKey> <edSignature> <file>
let arguments = CommandLine.arguments
guard arguments.count == 4 else {
    FileHandle.standardError.write(Data("usage: verify_ed_signature.swift <public-key> <signature> <file>\n".utf8))
    exit(2)
}
guard let keyData = Data(base64Encoded: arguments[1]),
      let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData),
      let signature = Data(base64Encoded: arguments[2]),
      let file = FileManager.default.contents(atPath: arguments[3])
else {
    FileHandle.standardError.write(Data("cannot read the public key, the signature or \(arguments[3])\n".utf8))
    exit(1)
}
guard key.isValidSignature(signature, for: file) else {
    FileHandle.standardError.write(Data("\(arguments[3]) is not signed by SUPublicEDKey \(arguments[1])\n".utf8))
    exit(1)
}
print("EdDSA signature matches SUPublicEDKey: \(arguments[3])")
