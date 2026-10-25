#
# Copyright (C) 2026 luci-app-thermal contributors
#
# This is free software, licensed under the MIT License.
#

# The version follows the commit date: YYYY.MM.DD. It is evaluated before
# rules.mk is included so MAKEFILE_LIST still points at this file. A source
# tree without git falls back to the constant below, which can be overridden
# on the make command line for tarball builds. PKG_RELEASE keeps LuCI's
# default of 1.
THERMAL_PKG_DIR:=$(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
THERMAL_VERSION_INFO:=$(shell sh $(THERMAL_PKG_DIR)/scripts/version.sh 2>/dev/null)
PKG_VERSION?=$(if $(THERMAL_VERSION_INFO),$(THERMAL_VERSION_INFO),2026.10.25)

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-thermal

LUCI_TITLE:=Temperature sensors for the LuCI status page
LUCI_DESCRIPTION:=Adds a Temperature block to Status > Overview and a realtime \
	graph page under Status > Realtime Graphs. Reads every hwmon and \
	thermal-zone sensor the kernel exposes, recovers real trip points where \
	the kernel reports them, and marks assumed limits as assumed.
#
# drivetemp is what makes SATA/SAS drive temperatures readable at all; without
# it those drives report nothing. It is pulled in on x86 only, where a SATA or
# NVMe disk is the norm and flash is not scarce.
#
# Gating on PCI_SUPPORT instead would be wrong: ath79 and ramips routers carry
# PCI for their wireless cards, so that test would push libata, scsi_mod and
# sd_mod onto small-flash devices that have no drive to measure.
#
# Everywhere else the dependency is simply absent, so the package stays
# installable on targets where kmod-ata-core is unavailable.
# ucode-mod-uci is imported by the backend to read /etc/config/thermal.
LUCI_DEPENDS:=+luci-base +rpcd-mod-ucode +ucode-mod-fs +ucode-mod-uci \
	+TARGET_x86:kmod-hwmon-drivetemp
LUCI_PKGARCH:=all

PKG_LICENSE:=MIT
PKG_MAINTAINER:=FateLightX

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
