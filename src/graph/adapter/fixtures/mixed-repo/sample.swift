import Foundation

class Worker {
  func run() -> String {
    "ok"
  }
}

struct Payload {}

protocol Runnable {
  func execute()
}

func build() -> Worker {
  Worker()
}

extension Worker {
  func reset() {}
}
