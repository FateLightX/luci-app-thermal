#
# Copyright (C) 2026 luci-app-thermal contributors
#
# This is free software, licensed under the MIT License.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-thermal
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

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
LUCI_DEPENDS:=+luci-base +rpcd-mod-ucode +ucode-mod-fs \
	+TARGET_x86:kmod-hwmon-drivetemp
LUCI_PKGARCH:=all

PKG_LICENSE:=MIT
PKG_MAINTAINER:=FateLightX

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
