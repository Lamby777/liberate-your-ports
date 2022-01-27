//import * as ipaddr	from "ipaddr.js";
import * as utils	from "./utils";
import * as natPmp	from "./nat-pmp";
import * as pcp		from "./pcp";
import * as upnp	from "./upnp";

export interface ProtocolCompatibilityTable {
	natPmp:			boolean;
	pcp:			boolean;
	upnp:			boolean;
	upnpControlUrl: any; // fix later
}

export class PortControl {
	// A table that keeps track of information about active Mappings
	public activeMappings: Record<string, any> = {};
	
	// Array of previously tested working router IPs
	// Try these first when sending NAT-PMP and PCP requests
	public routerIpCache: string[] = [];

	public protocolSupportCache: ProtocolCompatibilityTable = {
		natPmp: undefined,
		pcp: undefined,
		upnp: undefined,
		upnpControlUrl: undefined
	}
	
	constructor(public dispatchEvent: any) {}

	/**
	* Add a port mapping through the NAT, using probeProtocolSupport()
	* If probeProtocolSupport() has not been previously called, i.e. 
	* protocolSupportCache is empty, then we try each protocol until one works
	**/
	addMapping(intPort: number, extPort: number, lifetime: number) {
		var _this = this;
	
		if (_this.protocolSupportCache.natPmp === undefined) {
			// We have no data in the protocolSupportCache,
			// so try opening a port with NAT-PMP, then PCP, then UPnP
			return _this.addMappingPmp(intPort, extPort, lifetime)
				.then((mapping) => {
					if (mapping.externalPort !== -1) {
						return mapping;
					}
					return _this.addMappingPcp(intPort, extPort, lifetime);
				}).then((mapping) => {
					if (mapping.externalPort !== -1) {
						return mapping;
					}
					return _this.addMappingUpnp(intPort, extPort, lifetime);
				});
		} else {
			// We have data from probing the router for protocol support,
			// so we can directly try one protocol, or return a failure Mapping
			if (_this.protocolSupportCache.natPmp) {
				return _this.addMappingPmp(intPort, extPort, lifetime);
			} else if (_this.protocolSupportCache.pcp) {
				return _this.addMappingPcp(intPort, extPort, lifetime);
			} else if (_this.protocolSupportCache.upnp) {
				return _this.addMappingUpnp(intPort, extPort, lifetime,
					_this.protocolSupportCache.upnpControlUrl);
			} else {
				var failureMapping = new utils.Mapping();
				failureMapping.errInfo =
					"No protocols are supported from last probe";
				return failureMapping;
			}
		}
	}

	async asyncPF(int: number, ext: number, life: number) {
		return this.addMapping(int, ext, life);
	}

	/** Delete the port mapping locally and from the router (and stop refreshes)
	* The port mapping must have a Mapping object in this.activeMappings
	* @public
	* @method deleteMapping
	* @param {number} extPort The external port of the mapping to delete
	* @return {Promise<boolean>} True on success, false on failure **/
	deleteMapping(extPort: number) {
		var mapping = this.activeMappings[extPort];
		if (mapping === undefined) {
			return Promise.resolve(false);
		}
		return mapping.deleter();
	}

	/**
	* Probes the NAT for NAT-PMP, PCP, and UPnP support,
	* and returns an object representing the NAT configuration
	* Don't run probe before trying to map a port, just try to map the port
	* @public
	* @method probeProtocolSupport
	* @return {Promise<{"natPmp": boolean, "pcp": boolean, "upnp": boolean}>}
	*/
	probeProtocolSupport() {
		var _this = this;
	
		return Promise.all([this.probePmpSupport(), this.probePcpSupport(),
		this.probeUpnpSupport(), this.getUpnpControlUrl()]).then((support) => {
			_this.protocolSupportCache.natPmp = support[0];
			_this.protocolSupportCache.pcp = support[1];
			_this.protocolSupportCache.upnp = support[2];
			_this.protocolSupportCache.upnpControlUrl = support[3];
	
			return {
				natPmp: support[0],
				pcp: support[1],
				upnp: support[2]
			}
		});
	}
	
	/** Probe if NAT-PMP is supported by the router */
	probePmpSupport(): Promise<boolean> {
		return natPmp.probeSupport(this.activeMappings, this.routerIpCache);
	}
	
	/** Makes a port mapping in the NAT with NAT-PMP,
	 *	and automatically refresh the mapping every two minutes */
	addMappingPmp(intPort: number, extPort: number, lifetime: number) {
		return natPmp.addMapping(intPort, extPort, lifetime,
								 this.activeMappings, this.routerIpCache);
	}
	
	/**
	* Deletes a port mapping in the NAT with NAT-PMP
	* The port mapping must have a Mapping object in this.activeMappings
	*/
	deleteMappingPmp(extPort: number): Promise<boolean> {
		var mapping = this.activeMappings[extPort];
		if (mapping === undefined || mapping.protocol !== 'natPmp') {
			return Promise.resolve(false);
		}
		return mapping.deleter();
	}
	
	/**
	* Probe if PCP is supported by the router
	* @return {Promise<boolean>} A promise for a boolean */
	probePcpSupport() {
		return pcp.probeSupport(this.activeMappings, this.routerIpCache);
	}
	
	/**
	* Makes a port mapping in the NAT with PCP,
	* and automatically refresh the mapping every two minutes
	* @return {Promise<Mapping>} A promise for the port mapping object 
	*                            mapping.externalPort is -1 on failure */
	addMappingPcp(intPort: number, extPort: number, lifetime: number) {
		return pcp.addMapping(intPort, extPort, lifetime,
							  this.activeMappings, this.routerIpCache);
	}
	
	/** Deletes a port mapping in the NAT with PCP
	* The port mapping must have a Mapping object in this.activeMappings */
	deleteMappingPcp(extPort: number): Promise<boolean> {
		var mapping = this.activeMappings[extPort];
		if (mapping === undefined || mapping.protocol !== 'pcp') {
			return Promise.resolve(false);
		}
		return mapping.deleter();
	}
	
	/** Probe if UPnP AddPortMapping is supported by the router
	* @public
	* @method probeUpnpSupport
	* @return {Promise<boolean>} A promise for a boolean
	*/
	probeUpnpSupport() {
		return upnp.probeSupport(this.activeMappings);
	}
	
	/** Makes a port mapping in the NAT with UPnP AddPortMapping
	* @return {Promise<Mapping>} A promise for the port mapping object 
	*                               mapping.externalPort is -1 on failure */
	addMappingUpnp(intPort: number,	extPort: number,
					lifetime: number, controlUrl?: string) {
		return upnp.addMapping(intPort, extPort, lifetime,
							   this.activeMappings, controlUrl);
	}
	
	/** Deletes a port mapping in the NAT with UPnP DeletePortMapping
	* The port mapping must have a Mapping object in this.activeMappings
	* @return {Promise<boolean>} True on success, false on failure */
	deleteMappingUpnp(extPort: number) {
		var mapping = this.activeMappings[extPort];
		if (mapping === undefined || mapping.protocol !== 'upnp') {
			return Promise.resolve(false);
		}
		return mapping.deleter();
	};
	
	/** Return UPnP control URL of a router that supports UPnP IGD
	 * @public
	 * @method getUpnpControlUrl
	 * @return {Promise<string>} A promise for the URL,
	 * 							 empty string if not supported
	 */
	getUpnpControlUrl() {
		return upnp.getUpnpControlUrl();
	};
	
	/**
	* Returns the current value of activeMappings
	* @public
	* @method getActiveMappings
	* @return {Promise<activeMappings>} A promise that resolves to activeMappings
	*/
	getActiveMappings() {
		return Promise.resolve(this.activeMappings);
	};
	
	/** Return the router IP cache */
	getRouterIpCache(): Promise<string[]> {
		return Promise.resolve(this.routerIpCache);
	}
	
	/** Resolve to protocol support cache */
	getProtocolSupportCache() {
		return Promise.resolve(this.protocolSupportCache);
	}
	
	/** Return the private IP addresses of the computer
	* @return {Promise<Array<string>>} A promise that fulfills with a list of IPs,
	*                                  or rejects on timeout */
	getPrivateIps() {
		return utils.getPrivateIps();
	}
	
	/** Deletes all the currently active port mappings */
	close() {
		var _this = this;
	
		return new Promise((F, R) => {
			// Get all the keys (extPorts) of activeMappings
			var extPorts: number[] = [];
			_this.activeMappings.forEach((_: any, extPort: number) => {
				if (_this.activeMappings.hasOwnProperty(extPort)) {
					extPorts.push(extPort);
				}
			});
	
			// Delete them all
			Promise.all(extPorts.map(_this.deleteMapping.bind(_this)))
				.then(() => { F(); }
			);
		});
	}
}

//if (typeof freedom !== 'undefined') freedom().providePromises(PortControl);
