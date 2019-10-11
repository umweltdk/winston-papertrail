import { EventEmitter } from "events";
import { SPLAT } from 'triple-beam';
import * as Transport from 'winston-transport';
import * as glossy from 'glossy';
import * as net from 'net';
import * as os from 'os';
import * as tls from 'tls';
import { inspect } from 'util';

/**
 * winston-papertrail.js
 *
 * Transport for logging to Papertrail service
 * https://papertrailapp.com/
 *
 * Based on a previous version (1.x) by Ken Perkins.
 *
 * Transcribed to typescript by Umwelt A/S
 */

const KEEPALIVE_INTERVAL = 15 * 1000;

interface IconnectionOptions {
	host: string,
	port: number,
	attemptsBeforeDecay?: any;
	connectionDelay?: any;
	maxDelayBetweenConnections?: number,
	maximumAttempts?: number,
	disableTls?: boolean,
	flushOnClose?: boolean,
	loggingEnabled?: boolean,
}

interface ItransportOptions extends Transport.TransportStreamOptions {
	inlineMeta?: boolean;
	colorize?: boolean;
	program?: string;
	facility?: string;
	hostname?: string;
	depth?: any;
	levels?: {
		silly: number;
		debug: number;
		verbose: number;
		info: number;
		warn: number;
		error: number;
	};
	logFormat?: (level: any, message: any) => string;
};

export class PapertrailConnection extends EventEmitter {
	private options: any;
	private connectionDelay: any;
	private currentRetries: number;
	private totalRetries: number;
	private loggingEnabled: boolean;
	private _shutdown: boolean;
	private deferredQueue: any[];
	private deferredQueueLength: number;
	private _erroring: any;
	private stream: any;
	private socket: any;
	private attemptsBeforeDecay: any;


	constructor(options: IconnectionOptions) {
		super();

		const DEFAULT_OPTIONS = {
			attemptsBeforeDecay: 5,
			connectionDelay: 1000,
			maxDelayBetweenConnections: 60000,
			maximumAttempts: 25,
			disableTls: false,
			flushOnClose: true,
			loggingEnabled: false,
		};

		this.options = Object.assign({}, DEFAULT_OPTIONS, options);

		this.connectionDelay = this.options.connectionDelay;
		this.currentRetries = 0;
		this.totalRetries = 0;
		this.loggingEnabled = this.options.loggingEnabled;
		this._shutdown = false;

		/**
		 * Dev could instantiate a new logger and then call logger.log immediately.
		 * We need a way to put incoming strings (from multiple transports) into
		 * a buffer queue.
		 */
		this.deferredQueue = [];
		this.deferredQueueLength = 0;

		this.connect();
	}

	connect() {
		if (this._shutdown || this._erroring) {
			return;
		}

		this.close();

		try {
			if (this.options.disableTls) {
				this.stream = net.createConnection(this.options.port, this.options.host, this.onConnected.bind(this));
				this.stream.setKeepAlive(true, KEEPALIVE_INTERVAL);
				this.stream.once('error', this.onErrored.bind(this));
				this.stream.once('end', this.connect.bind(this));
			} else {
				this.socket = net.createConnection(this.options.port, this.options.host, () => {
					this.socket.setKeepAlive(true, KEEPALIVE_INTERVAL);

					this.stream = tls.connect({
						socket: this.socket,
						rejectUnauthorized: false,
					}, this.onConnected.bind(this));

					this.stream.once('error', this.onErrored.bind(this));
					this.stream.once('end', this.connect.bind(this));
				});

				this.socket.once('error', this.onErrored.bind(this));
			}
		} catch (err) {
			this.onErrored(err);
		}
	}

	write(text, callback) {
		if (this.loggingEnabled) {
			// If the stream is writable
			if (this.stream && this.stream.writable) {
				this.stream.write(text, callback);
			} else {
				// Otherwise, store it in a buffer and write it when we're connected
				this.deferredQueue.push({
					buffer: text,
					callback,
				});
				this.deferredQueueLength++;
			}
		}
	}

	processBuffer() {
		if (this.deferredQueue.length === 0 || !this.stream || !this.stream.writable) {
			return;
		}

		while (this.deferredQueue.length > 0) {
			const queueItem = this.deferredQueue.shift();

			const callback = () => {
				queueItem.callback();
				this.deferredQueueLength--;

				if (this.deferredQueueLength === 0) {
					this.stream.emit('empty');
				}
			};

			this.stream.write(queueItem.buffer, callback);
		}
	}

	onConnected() {
		this.currentRetries = 0;
		this.totalRetries = 0;
		this.connectionDelay = this.options.connectionDelay;

		this.processBuffer();

		this.emit('connect', `Connected to Papertrail at ${this.options.host}:${this.options.port}`);
	}

	onErrored(err) {
		this._erroring = true;

		this.emitSilentError(err);

		setTimeout(() => {
			if ((this.connectionDelay < this.options.maxDelayBetweenConnections)
				&& (this.currentRetries >= this.attemptsBeforeDecay)) {
				this.connectionDelay = this.connectionDelay * 2;
				this.currentRetries = 0;
			}

			if (this.loggingEnabled && this.totalRetries >= this.options.maximumAttempts) {
				this.loggingEnabled = false;
				this.emitSilentError(new Error('Max entries eclipsed, disabling buffering'));
			}

			this._erroring = false;
			this.connect();
		}, this.connectionDelay);
	}

	emitSilentError(err) {
		if (this.listenerCount('error') > 0) {
			this.emit('error', err);
		} else {
			console.error(`Papertrail connection error: ${err}`);
		}
	}

	clean() {
		try {
			if (this.socket) {
				this.socket.destroy();
				this.socket = null;
			}

			this.stream.removeListener('end', this.connect);
			this.stream.removeListener('error', this.onErrored);

			this.stream.destroy();
			this.stream = null;
		} catch (ignored) { }
	}

	close() {
		this._shutdown = true;

		if (this.stream) {
			if (this.options.flushOnClose && this.deferredQueueLength > 0) {
				this.stream.on('empty', () => {
					this.clean();
				});
			} else {
				this.clean();
			}
		}

		this._shutdown = false;
	}
}

export class PapertrailTransport extends Transport {
	connection: PapertrailConnection;
	options: ItransportOptions;
	producer: any;

	constructor(connection: PapertrailConnection, options: ItransportOptions) {
		super(options);

		const syslogProducer = glossy.Produce;
		const DEFAULT_OPTIONS = {
			inlineMeta: false,
			colorize: false,
			program: 'default',
			facility: 'daemon',
			hostname: os.hostname(),
			depth: null,
			levels: {
				silly: 7,
				debug: 7,
				verbose: 7,
				info: 6,
				warn: 4,
				error: 3,
			},
			logFormat: function (level: string, message: string): string {
				return level + ' ' + message;
			},
		};

		this.connection = connection;

		this.options = Object.assign({}, DEFAULT_OPTIONS, options);
		this.producer = new syslogProducer({ facility: this.options.facility });
	}

	log(info, callback) {
		setImmediate(() => {
			this.emit('logged', info);
		});


		// write to Papertrail
		const { level, message } = info;
		const meta = info[SPLAT];
		let output = message;

		if (meta) {
			if (typeof meta !== 'object') {
				output += ' ' + meta;
			} else if (meta) {
				output += '\n' + meta.map(data => {
					return inspect(data, {
						showHidden: false,
						depth: this.options.depth,
						colors: this.options.colorize,
					});
				})
					.join('\n');

				if (this.options.inlineMeta) {
					output = output.replace(/[\n\t]\s*/gm, ' ');
				}
			}
		}

		this.sendMessage(level, output, callback);
	}

	sendMessage(level, message, callback) {
		let lines = [];
		let msg = '';
		let gap = '';

		// Only split if we actually have a message
		if (message) {
			lines = message.split('\n');
		} else {
			lines = [''];
		}

		// If the incoming message has multiple lines, break them and format each
		// line as its own message
		for (let i = 0; i < lines.length; i++) {
			// don't send extra message if our message ends with a newline
			if (lines[i].length === 0 && i === lines.length - 1) {
				break;
			}

			if (i === 1) {
				gap = '   ';
			}

			// Strip escape characters (for colorization)
			const cleanedLevel = level.replace(/\u001b\[\d+m/g, '');
			msg +=
				this.producer.produce({
					severity: this.options.levels[cleanedLevel] || cleanedLevel,
					host: this.options.hostname,
					appName: this.options.program,
					date: new Date(),
					message: this.options.logFormat(level, gap + lines[i]),
				}) + '\r\n';
		}


		this.connection.write(msg, callback);
	}

	close() {
		this.connection.close();
	}
}
