#
# Copyright (C) 2026 FateLightX
#
# This is free software, licensed under the MIT License.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-thermal
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

LUCI_TITLE:=Temperature sensors for the LuCI status page
LUCI_DESCRIPTION:=Adds a Temperature block to Status > Overview. Reads every \
	hwmon and thermal-zone sensor the kernel exposes, recovers real trip \
	points where the kernel reports them, and marks assumed limits as assumed.
LUCI_DEPENDS:=+luci-base +rpcd-mod-ucode +ucode-mod-fs
LUCI_PKGARCH:=all

PKG_LICENSE:=MIT
PKG_MAINTAINER:=FateLightX

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
