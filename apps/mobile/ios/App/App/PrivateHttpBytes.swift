import Foundation

/** URLSession's OS trust/hostname/ATS policy is untouched. This class owns only one HTTP body. */
final class PrivateHttpBytes: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
    private let queue = DispatchQueue(label: "dev.bagakit.agentmux.mobile.http-bytes")
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var chunks: [Data] = []
    private var bytes = 0
    private var suspended = false
    private var headersReceived = false
    private var finished = false
    private var failure: Error?
    private var waiting: ((Result<Data?, Error>) -> Void)?
    private let headers: (Int, [String: String]) -> Void
    private let failedOpen: (Error) -> Void
    private let maximumBuffered = 256 * 1024
    private let chunkSize = 64 * 1024

    init(request: URLRequest, headers: @escaping (Int, [String: String]) -> Void,
         failedOpen: @escaping (Error) -> Void) {
        self.headers = headers; self.failedOpen = failedOpen
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        delegateQueue.underlyingQueue = queue
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
        task = session?.dataTask(with: request)
    }
    func start() { task?.resume() }
    func read(_ callback: @escaping (Result<Data?, Error>) -> Void) {
        queue.async {
            guard self.waiting == nil else { callback(.failure(PrivateTransportFailure.invalid)); return }
            self.waiting = callback; self.drain()
        }
    }
    func cancel() {
        queue.async {
            self.failure = PrivateTransportFailure.cancelled; self.finished = true
            self.chunks.removeAll(); self.bytes = 0
            self.task?.cancel(); self.session?.invalidateAndCancel()
            self.drain()
        }
    }
    private func drain() {
        guard let callback = waiting else { return }
        if !chunks.isEmpty {
            let first = chunks.removeFirst(), count = min(chunkSize, first.count)
            let output = Data(first.prefix(count))
            if count < first.count { chunks.insert(Data(first.dropFirst(count)), at: 0) }
            bytes -= count; waiting = nil
            if suspended && bytes < chunkSize && !finished { suspended = false; task?.resume() }
            callback(.success(output))
        } else if finished {
            waiting = nil
            if let failure = failure { callback(.failure(failure)) } else { callback(.success(nil)) }
            session?.finishTasksAndInvalidate()
        }
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse, !(300..<400).contains(response.statusCode) else {
            failure = PrivateTransportFailure.invalid; completionHandler(.cancel); return
        }
        headersReceived = true
        var values: [String: String] = [:]
        for (key, value) in response.allHeaderFields {
            let name = String(describing: key).lowercased()
            if name != "set-cookie" && name != "authorization" { values[name] = String(describing: value) }
        }
        headers(response.statusCode, values); completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !finished else { return }
        guard bytes + data.count <= maximumBuffered else {
            failure = PrivateTransportFailure.unavailable; finished = true; task?.cancel(); drain(); return
        }
        if !data.isEmpty { chunks.append(data); bytes += data.count }
        drain()
        if !suspended && bytes >= chunkSize { suspended = true; task?.suspend() }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if failure == nil { failure = error }
        finished = true
        if !headersReceived { failedOpen(failure ?? PrivateTransportFailure.unavailable) }
        drain()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Even another trusted host is not this credential's immutable origin.
        failure = PrivateTransportFailure.invalid; completionHandler(nil)
    }
}
